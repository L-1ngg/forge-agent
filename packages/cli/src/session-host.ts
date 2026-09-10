import { createAgent, createPiPort, RequestBus, SessionStore, type Agent, type AgentPort, type CreateAgentOptions, type PiPortOptions, type SessionEntry, type SessionState, type SessionStorage } from "@forge-agent/core";
import type { SessionMessage } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SessionPreviewMessage { role: "user" | "assistant"; text: string; truncated: boolean; stopReason?: string; }
export interface SessionPreview { id: string; revision: string; messages: SessionPreviewMessage[]; }
export interface SessionSummary { id: string; title: string; updatedAt: number; }
export interface SessionView {
	id: string;
	port: Agent;
	requestBus: RequestBus;
	history: readonly SessionMessage[];
	hasHistory(): boolean;
}

type HostOptions = Omit<CreateAgentOptions, "storage" | "sessionId" | "requestBus"> & { requestTimeoutMs?: number | null };
type PortFactory = (options: PiPortOptions) => AgentPort | Promise<AgentPort>;

async function fileRevision(path: string): Promise<string> {
	const info = await stat(path);
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}
function excerpt(text: string, limit: number): { text: string; truncated: boolean } {
	let result = "", length = 0;
	for (const character of text) {
		if (length++ === limit) return { text: result, truncated: true };
		result += character;
	}
	return { text: result, truncated: false };
}

async function projectRoot(cwd: string): Promise<string> {
	const path = await realpath(cwd);
	const child = Bun.spawn(["git", "-C", path, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
	const output = (await new Response(child.stdout).text()).trim();
	return await child.exited === 0 ? realpath(output) : path;
}

async function directoryEntries(path: string) {
	try { return await readdir(path, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** No file exists until the first consumed input is committed. */
class NewSessionStorage implements SessionStorage {
	private store: SessionStore | undefined;
	constructor(readonly path: string, private readonly cwd: string, private readonly id: string) { }
	load(): Promise<SessionState> { return this.store?.load() ?? Promise.resolve({ entries: [], leafId: null }); }
	get saved(): boolean { return this.store !== undefined; }
	async append(entry: SessionEntry): Promise<void> {
		if (this.store) return this.store.append(entry);
		await mkdir(dirname(this.path), { recursive: true });
		const header = { type: "session", version: 4, id: this.id, cwd: this.cwd, timestamp: new Date().toISOString() };
		await writeFile(this.path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, { flag: "wx" });
		this.store = await SessionStore.open(this.path, this.cwd);
	}
}

/** CLI owns selection and instance lifetime; core continues to own execution and commits. */
export class SessionHost {
	private view!: SessionView;
	private switching = false;
	private closed = false;
	private operation: Promise<SessionView> | undefined;
	private available = new Set<string>();
	private summaries = new Map<string, { revision: string; summary?: SessionSummary; diagnostics: string[] }>();
	private constructor(private readonly root: string, private readonly options: HostOptions, private readonly factory: PortFactory) { }
	static async create(options: HostOptions, factory: PortFactory = createPiPort): Promise<SessionHost> {
		const host = new SessionHost(await projectRoot(options.cwd), options, factory);
		host.view = await host.prepare();
		return host;
	}
	get current(): SessionView { return this.view; }
	private async prepare(path?: string): Promise<SessionView> {
		const store = path ? await SessionStore.open(path, this.options.cwd, { create: false }) : undefined;
		if (store && !store.messages().some(message => message.role === "user")) throw new Error("Session has no conversation history");
		if (store && !store.appendable) throw new Error("Session contains damaged records; convert a verified copy before resuming");
		const id = store?.header.id ?? randomUUID();
		const file = path ?? join(this.root, ".forge-agent", "sessions", `${id}.jsonl`);
		const storage = store ?? new NewSessionStorage(file, this.options.cwd, id);
		const requestBus = new RequestBus({ timeoutMs: this.options.requestTimeoutMs ?? null });
		try {
			const port = await createAgent({ ...this.options, sessionId: id, storage, requestBus }, this.factory);
			return { id: file, port, requestBus, history: store?.messages() ?? [], hasHistory: () => store !== undefined || storage instanceof NewSessionStorage && storage.saved };
		} catch (error) { requestBus.close(); throw error; }
	}
	async list(): Promise<{ sessions: SessionSummary[]; diagnostics: string[] }> {
		const directory = join(this.root, ".forge-agent", "sessions");
		const files = (await directoryEntries(directory)).filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => join(directory, entry.name));
		const managed = new Set(files);
		const diagnostics: string[] = [];
		// Discover the old default files without traversing dependency stores or other worktrees.
		const visit = async (path: string): Promise<void> => {
			const entries = await directoryEntries(path);
			for (const entry of entries) {
				if (!entry.isDirectory() || [".git", "node_modules"].includes(entry.name)) continue;
				const child = join(path, entry.name);
				if (entry.name === ".forge-agent") {
					if ((await directoryEntries(child)).some(item => item.name === "session.jsonl" && item.isFile())) files.push(join(child, "session.jsonl"));
				} else if (!entry.name.startsWith(".")) {
					const nested = await directoryEntries(child);
					if (!nested.some(item => item.name === ".git")) await visit(child);
				}
			}
		};
		await visit(this.root);
		const sessions: SessionSummary[] = [];
		const discovered = new Set(files);
		for (const file of this.summaries.keys()) if (!discovered.has(file)) this.summaries.delete(file);
		for (const file of files) {
			try {
				// Managed files belong to this project even if their original tool cwd was removed.
				if (!managed.has(file) && await projectRoot(dirname(dirname(file))) !== this.root) continue;
				const revision = await fileRevision(file);
				let cached = this.summaries.get(file);
				if (!cached || cached.revision !== revision) {
					const store = await SessionStore.open(file, this.options.cwd, { create: false });
					const messages = store.messages();
					const first = messages.find(message => message.role === "user");
					const title = first?.content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ").replace(/\s+/g, " ").trim() ?? "";
					cached = { revision, diagnostics: store.appendable ? [] : [`${file}: damaged records; convert a verified copy before resuming`], ...(first ? { summary: { id: file, title: excerpt(title, 160).text || "无文本会话", updatedAt: messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0) } } : {}) };
					// Do not cache a read that raced an append or replacement.
					if (await fileRevision(file) === revision) this.summaries.set(file, cached);
					else this.summaries.delete(file);
				}
				diagnostics.push(...cached.diagnostics);
				if (cached.summary) sessions.push({ ...cached.summary });
			} catch (error) { this.summaries.delete(file); diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		this.available = new Set(sessions.map(session => session.id));
		return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), diagnostics };
	}
	async preview(id: string, cached?: SessionPreview): Promise<SessionPreview> {
		if (!this.available.has(id)) throw new Error("Session is not available in this project");
		const revision = await fileRevision(id);
		if (cached?.id === id && cached.revision === revision) return cached;
		const store = await SessionStore.open(id, this.options.cwd, { create: false });
		const messages: SessionPreviewMessage[] = [];
		for (const message of store.messages().reverse()) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = message.content.flatMap(part => part.type === "text" ? [part.text] : part.type === "image" ? ["[图片]"] : []).join("\n").trim();
			if (!text) continue;
			messages.unshift({ role: message.role, ...excerpt(text, 500), ...(message.stopReason ? { stopReason: message.stopReason } : {}) });
			if (messages.length === 6) break;
		}
		return { id, revision: await fileRevision(id) === revision ? revision : "", messages };
	}

	switchTo(id?: string, beforeRelease: () => Promise<void> = async () => {}): Promise<SessionView> {
		if (this.closed) return Promise.reject(new Error("Session host is closed"));
		if (this.switching) return Promise.reject(new Error("A session switch is already in progress"));
		if (id === this.view.id) return Promise.resolve(this.view);
		this.switching = true;
		this.operation = this.performSwitch(id, beforeRelease).finally(() => { this.switching = false; this.operation = undefined; });
		return this.operation;
	}
	private async performSwitch(id: string | undefined, beforeRelease: () => Promise<void>): Promise<SessionView> {
		if (id && !(await this.list()).sessions.some(session => session.id === id)) throw new Error("Session is not available in this project");
		const next = await this.prepare(id);
		try {
			if (this.closed) throw new Error("Session host is closed");
			await beforeRelease();
			await this.view.port.dispose();
			if (this.closed) throw new Error("Session host is closed");
			this.view = next;
			return next;
		} catch (error) { await next.port.dispose(); throw error; }
	}
	async dispose(): Promise<void> {
		this.closed = true;
		this.summaries.clear(); this.available.clear();
		this.view.port.abort();
		await this.operation?.catch(() => {});
		await this.view.port.dispose();
	}
}
