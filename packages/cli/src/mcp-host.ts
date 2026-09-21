import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import open from "open";
import { McpError, type McpCredentialStore, type McpCredentialRecord, type McpArtifactStore, type McpArtifactReference, type McpInteraction } from "@forge-agent/core/sdk";
import type { RequestBus } from "@forge-agent/core";

/** Native calls retain transaction ownership until they actually settle. Cancellation
 * prevents later writes; it never releases a lock underneath a pending native write. */
export class SystemMcpCredentialStore implements McpCredentialStore {
	private context = new AsyncLocalStorage<AbortSignal>();
	constructor(readonly backend: "system" | "linux-keyutils" = "system", private cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "forge-agent", "mcp-locks"), private service = "forge-agent-mcp") {}
	private async entry(key: string) {
		try { const { AsyncEntry } = await import("@napi-rs/keyring"); return new AsyncEntry(this.service, key, process.platform === "linux" ? { linux: { store: this.backend === "linux-keyutils" ? "keyutils" : "secret-service" } } : undefined); }
		catch { throw new McpError("backend-unavailable", `MCP credential backend ${this.backend} is unavailable`); }
	}
	private check() { this.context.getStore()?.throwIfAborted(); }
	async read(key: string) {
		this.check(); let value: string | undefined;
		try { value = await (await this.entry(key)).getPassword(); } catch { throw new McpError("backend-unavailable", `MCP credential backend ${this.backend} cannot be read`); }
		if (value == null) return undefined;
		const record: McpCredentialRecord = JSON.parse(value);
		if (record.schemaVersion !== 1 || typeof record.issuer !== "string" || typeof record.resource !== "string" || typeof record.authProfile !== "string") throw new McpError("credential-invalid", "Invalid MCP credential record");
		return record;
	}
	async write(key: string, record: McpCredentialRecord) { this.check(); const entry = await this.entry(key); this.check(); try { await entry.setPassword(JSON.stringify(record)); } catch { throw new McpError("credential-outcome-unknown", "MCP credential write did not confirm completion"); } this.check(); }
	async delete(key: string) { this.check(); const entry = await this.entry(key); this.check(); try { await entry.deleteCredential(); } catch { throw new McpError("logout-incomplete", "MCP credential deletion did not confirm completion"); } this.check(); }
	async withLock<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		await mkdir(this.cache, { recursive: true, mode: 0o700 }); const target = join(this.cache, createHash("sha256").update(key).digest("hex")); await writeFile(target, "", { flag: "a", mode: 0o600 });
		const lost = new AbortController(); const active = AbortSignal.any([lost.signal, ...(signal ? [signal] : [])]);
		active.throwIfAborted();
		let release: () => Promise<void>;
		try { release = await lockfile.lock(target, { stale: 30000, update: 10000, retries: { retries: 20, factor: 1, minTimeout: 500, maxTimeout: 500 }, onCompromised: () => lost.abort(new McpError("credential-lock-lost", "MCP credential transaction lock was lost")) }); }
		catch { throw new McpError("credential-lock", "MCP credential transaction lock is unavailable"); }
		try { active.throwIfAborted(); const result = await this.context.run(active, () => operation(active)); active.throwIfAborted(); return result; }
		finally { await release(); }
	}
}

export class FileMcpArtifactStore implements McpArtifactStore {
	constructor(private root: string) {}
	private path(id: string) { if (!/^[0-9a-f-]{36}$/.test(id)) throw new McpError("artifact-missing", "Invalid artifact identifier"); return join(this.root, id); }
	async put(bytes: Uint8Array, metadata: { mimeType: string; name?: string }, signal?: AbortSignal): Promise<McpArtifactReference> {
		signal?.throwIfAborted(); await mkdir(this.root, { recursive: true, mode: 0o700 }); const id = randomUUID(); const reference = { ...metadata, id, size: bytes.byteLength }; const path = this.path(id);
		try { await writeFile(path, bytes, { flag: "wx", mode: 0o600, ...(signal ? { signal } : {}) }); await writeFile(`${path}.json`, JSON.stringify(reference), { flag: "wx", mode: 0o600, ...(signal ? { signal } : {}) }); return reference; }
		catch (error) { await this.delete(id); throw error; }
	}
	async read(id: string, signal?: AbortSignal) { signal?.throwIfAborted(); try { const path = this.path(id); const [bytes, metadata] = await Promise.all([readFile(path), readFile(`${path}.json`, "utf8")]); return { bytes, metadata: JSON.parse(metadata) as McpArtifactReference }; } catch { throw new McpError("artifact-missing", "Saved MCP artifact is missing; no remote fetch was performed"); } }
	async delete(id: string) { const path = this.path(id); for (const file of [path, `${path}.json`]) { try { await unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } }
}

export async function openMcpUrl(url: string): Promise<void> { const parsed = new URL(url); if (!["https:", "http:"].includes(parsed.protocol)) throw new McpError("invalid-url", "Only HTTP(S) authorization URLs can be opened"); await open(parsed.href, { wait: false }); }
export function browserMcpInteraction(bus: RequestBus, openUrl: (url: string) => Promise<void> = openMcpUrl): McpInteraction {
	return { async beginAuthorization({ serverId, signal }) {
		let expectedState: string | undefined, settled = false;
		let resolve!: (params: URLSearchParams) => void, reject!: (error: unknown) => void;
		const callback = new Promise<URLSearchParams>((yes, no) => { resolve = yes; reject = no; }); callback.catch(() => {});
		const abort = () => { if (!settled) { settled = true; reject(new McpError("oauth-canceled", "MCP login canceled or expired")); } };
		signal.addEventListener("abort", abort, { once: true });
		const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
			const url = new URL(request.url);
			if (settled || signal.aborted || url.pathname !== "/callback" || !expectedState || url.searchParams.get("state") !== expectedState) return new Response("Invalid or expired authorization callback", { status: 400 });
			settled = true; resolve(url.searchParams); return new Response("Authorization callback received. Return to Forge Agent to check the result.");
		} });
		const card = new AbortController();
		return { redirectUri: `http://127.0.0.1:${listener.port}/callback`, async authorize(url) {
				signal.throwIfAborted(); expectedState = url.searchParams.get("state") ?? undefined;
				void bus.ask("oauth", { provider: `MCP ${serverId}`, authorizationUrl: url.href, instructions: "Complete authorization in your browser. Continue does not confirm authentication; Forge verifies the callback and saved credentials." }, { signal: AbortSignal.any([signal, card.signal]), timeoutMs: 300000 }).then(result => { if (result.status !== "response" || result.result.decision === "cancel") abort(); });
				try { await openUrl(url.href); } catch { /* URL is visible in the card */ }
				return callback;
			}, async close() { card.abort(); signal.removeEventListener("abort", abort); abort(); await listener.stop(true); } };
	} };
}

/** Standalone management can locate a saved ID across this project's session
 * directories. Model-facing Agents still receive only their own session store. */
export class ProjectMcpArtifactStore extends FileMcpArtifactStore {
	constructor(private directory: string) { super(join(directory, "management")); }
	override async read(id: string, signal?: AbortSignal) {
		const { readdir } = await import("node:fs/promises");
		let directories;
		try { directories = await readdir(this.directory, { withFileTypes: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new McpError("artifact-missing", "Saved MCP artifact is missing"); throw error; }
		for (const directory of directories) {
			if (!directory.isDirectory()) continue;
			try { return await new FileMcpArtifactStore(join(this.directory, directory.name)).read(id, signal); }
			catch (error) { if (!(error instanceof McpError) || error.code !== "artifact-missing") throw error; }
		}
		throw new McpError("artifact-missing", "Saved MCP artifact is missing; no remote fetch was performed");
	}
}
