import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { memoryFiles, memoryLock, missing, type MemoryFileSystem } from "./files.ts";

export type MemoryScope = "user" | "project";
export interface MemorySource { kind: "management" | "session"; timestamp: string; sessionId?: string; entryId?: string; location?: string; scope?: MemoryScope; scopeRoot?: string; }
export interface MemoryWrite { scope: MemoryScope; path: string; content: string; expectedVersion: string | null; operationId: string; indexBudgetTokens?: number; }
export interface MemoryRead {
	scope: MemoryScope; path: string; text: string; version: string; modifiedAt: string;
	sources: MemorySource[]; warnings: string[]; nextOffset?: number;
}
export interface MemoryCommit { saved: boolean; deleted?: boolean; scope: MemoryScope; path: string; version: string | null; indexStatus: string; replayed?: boolean; warnings: string[]; }
interface Receipt { request: string; contentHash: string | null; result?: MemoryCommit; }
export const MEMORY_FILE_BYTES = 256 * 1024;
export const MEMORY_PAGE_CHARS = 4096;
export const memoryHash = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

/** Bound directories are the authority; Markdown fields never select a scope. */
export class LongTermMemory {
	constructor(readonly roots: Readonly<Partial<Record<MemoryScope, string>>>, private readonly files: MemoryFileSystem = memoryFiles) {
		this.roots = Object.freeze({ ...roots });
		for (const root of Object.values(roots)) if (resolve(root) !== root) throw new Error("Memory roots must be absolute normalized paths");
	}
	async read(scope: MemoryScope, path: string, offset = 0, limit = MEMORY_PAGE_CHARS): Promise<MemoryRead> {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_PAGE_CHARS) throw new Error("Invalid memory page");
		const { text, version, modifiedAt } = await this.readFull(scope, path);
		const chars = [...text];
		if (offset > chars.length) throw new Error("Memory offset out of range");
		const sources: MemorySource[] = [], warnings: string[] = [];
		let annotations = 0;
		for (const match of text.matchAll(/<!-- forge-memory-source (.*?) -->/g)) {
			if (++annotations > 4 || match[1]!.length > 2048) { warnings.push("Source metadata exceeds display budget; inspect raw Markdown by page"); break; }
			try {
				const source = JSON.parse(match[1]!);
				if (!source || !["management", "session"].includes(source.kind) || typeof source.timestamp !== "string" || ["sessionId", "entryId", "location", "scopeRoot"].some(key => source[key] !== undefined && typeof source[key] !== "string")) throw new Error("Invalid source");
				sources.push(source);
			} catch { warnings.push("Invalid source metadata; raw text preserved"); }
		}
		if (!sources.length) warnings.push("Source unavailable; content has not been historically verified");
		else warnings.push("Source pointers are not verified here; referenced history may be unavailable or not persisted. External edits do not reverify sources");
		if (text.startsWith("---\n")) {
			const end = text.indexOf("\n---", 4);
			if (end < 0) warnings.push("Invalid optional frontmatter; raw text preserved");
			else { try { Bun.YAML.parse(text.slice(4, end)); } catch { warnings.push("Invalid optional frontmatter; raw text preserved"); } }
		}
		return { scope, path, text: chars.slice(offset, offset + limit).join(""), version, modifiedAt, sources, warnings, ...(offset + limit < chars.length ? { nextOffset: offset + limit } : {}) };
	}
	async write(input: MemoryWrite, source: MemorySource, signal?: AbortSignal): Promise<MemoryCommit> {
		signal?.throwIfAborted();
		if (typeof input.content !== "string") throw new Error("Memory content must be Markdown text");
		if (input.indexBudgetTokens !== undefined && (!Number.isInteger(input.indexBudgetTokens) || input.indexBudgetTokens < 0 || input.indexBudgetTokens > 2000)) throw new Error("Invalid memory index budget");
		this.file(input.scope, input.path);
		const content = `${input.content}\n\n<!-- forge-memory-source ${JSON.stringify({ ...source, scope: input.scope, scopeRoot: this.root(input.scope), operationId: input.operationId })} -->\n`;
		if (Buffer.byteLength(content) > MEMORY_FILE_BYTES) throw new Error("Memory write exceeds 256 KiB resource limit");
		return this.commit(input.scope, input.path, input.expectedVersion, input.operationId, content, signal, input.content, input.indexBudgetTokens);
	}
	async delete(scope: MemoryScope, path: string, expectedVersion: string, operationId: string, signal?: AbortSignal): Promise<MemoryCommit> {
		return this.commit(scope, path, expectedVersion, operationId, null, signal);
	}
	private async commit(scope: MemoryScope, path: string, expected: string | null, operationId: string, content: string | null, signal?: AbortSignal, requestedContent = content, indexBudgetTokens?: number): Promise<MemoryCommit> {
		if (!operationId || operationId.length > 200 || (expected !== null && typeof expected !== "string")) throw new Error("Invalid memory operation identity or version");
		const root = this.root(scope), file = this.file(scope, path);
		await this.noSymlink(root);
		return memoryLock(root, async () => {
			await this.checkPath(scope, path);
			const receipts = join(root, ".operations");
			await this.noSymlink(receipts); await this.files.mkdir(receipts, { recursive: true });
			const receiptPath = join(receipts, `${memoryHash(operationId)}.json`);
			await this.noSymlink(receiptPath);
			const request = memoryHash(JSON.stringify([scope, path, expected, requestedContent]));
			let receipt: Receipt | undefined;
			try { receipt = JSON.parse(await this.files.readFile(receiptPath, "utf8")); } catch (error) { if (!missing(error)) throw error; }
			if (receipt && receipt.request !== request) throw new Error("Memory operation identity reused with different content");
			if (receipt?.result) return { ...receipt.result, replayed: true };
			const current = await this.readFull(scope, path).catch(error => { if (missing(error)) return null; throw error; });
			const alreadyPublished = receipt && (content === null ? current === null : current?.contentHash === receipt.contentHash);
			if (!alreadyPublished && (current?.version ?? null) !== expected) throw new Error("Memory target changed or was deleted; read again before editing");
			if (!alreadyPublished) {
				await this.files.mkdir(dirname(file), { recursive: true });
				await this.atomic(receiptPath, JSON.stringify({ request, contentHash: content === null ? null : memoryHash(content) }));
				if (content === null) {
					signal?.throwIfAborted();
					if ((await this.readFull(scope, path)).version !== expected) throw new Error("Memory target changed before deletion; read again");
					await this.files.unlink(file);
				}
				else await this.atomic(file, content, async () => {
					signal?.throwIfAborted(); await this.checkPath(scope, path);
					const latest = await this.readFull(scope, path).catch(error => { if (missing(error)) return null; throw error; });
					if ((latest?.version ?? null) !== expected) throw new Error("Memory target changed before commit; read again");
				});
			}
			const final = content === null ? null : await this.readFull(scope, path);
			const warnings: string[] = [];
			if (path === "MEMORY.md" && content) {
				if (indexBudgetTokens === undefined) warnings.push("File saved; active injection budget unavailable. Shorten the index if needed: automatic loading is at most 2000 tokens and can be lower");
				else if (Math.ceil(content.length / 4) + 80 > indexBudgetTokens * 0.8) warnings.push(`File saved; shorten index. It approaches or exceeds the current shared ${indexBudgetTokens}-token injection budget and may be truncated`);
			}
			const result: MemoryCommit = { saved: content !== null, ...(content === null ? { deleted: true } : {}), scope, path, version: final?.version ?? null, indexStatus: path === "MEMORY.md" ? "saved" : "not-updated; model must maintain MEMORY.md separately", warnings };
			try { await this.atomic(receiptPath, JSON.stringify({ request, contentHash: final?.contentHash ?? null, result })); }
			catch (error) { throw new Error(`Memory file ${content === null ? "deleted" : "saved"}, but operation receipt failed: ${String(error)}`); }
			return { ...result, ...(alreadyPublished ? { replayed: true } : {}) };
		}, signal, this.files);
	}
	private async atomic(path: string, content: string, beforePublish?: () => Promise<void>): Promise<void> {
		const temporary = join(dirname(path), `.memory-${randomUUID()}.tmp`);
		try { await this.files.writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await beforePublish?.(); await this.files.rename(temporary, path); }
		finally { await this.files.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
	}
	private async readFull(scope: MemoryScope, path: string) {
		await this.checkPath(scope, path);
		const file = this.file(scope, path), handle = await this.files.open(file, "r");
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new Error("Memory path is not a regular file");
			if (info.size > MEMORY_FILE_BYTES) throw new Error("Memory file exceeds 256 KiB resource limit");
			const bytes = Buffer.alloc(MEMORY_FILE_BYTES + 1);
			let length = 0;
			while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
			if (length > MEMORY_FILE_BYTES) throw new Error("Memory file exceeds 256 KiB resource limit");
			const content = bytes.subarray(0, length), contentHash = memoryHash(content);
			const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
			if (text.includes("\0")) throw new Error("Memory file is not readable text (NUL bytes)");
			return { text, contentHash, version: memoryHash(`${contentHash}:${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`), modifiedAt: info.mtime.toISOString() };
		} finally { await handle.close(); }
	}
	private async noSymlink(path: string) {
		try { if ((await this.files.lstat(path)).isSymbolicLink()) throw new Error("Memory symlinks are not authorized"); }
		catch (error) { if (!missing(error)) throw error; }
	}
	private async checkPath(scope: MemoryScope, path: string) {
		this.file(scope, path);
		let current = this.root(scope); await this.noSymlink(current);
		for (const part of path.split("/")) { current = join(current, part); await this.noSymlink(current); }
	}
	async search(scope: MemoryScope, query: string, limit = 10, signal?: AbortSignal) {
		if (!query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Invalid memory search query or limit");
		const words = query.trim().split(/\s+/u);
		if (words.length > 8) throw new Error("Memory search allows at most 8 words");
		const patterns = words.map(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
		const matches: Array<{ path: string; text: string; offset: number; version: string; scope: MemoryScope }> = [];
		const warnings: string[] = [];
		let bytes = 0, hasMore = false;
		for (const path of await this.list(scope)) {
			signal?.throwIfAborted();
			try {
				const note = await this.readFull(scope, path);
				bytes += Buffer.byteLength(note.text);
				if (bytes > 8 * 1024 * 1024) { warnings.push("Memory search reached the 8 MiB scan budget; use read_memory by path"); hasMore = true; break; }
				const hits = patterns.map(pattern => pattern.exec(note.text));
				if (hits.some(hit => !hit)) continue;
				if (matches.length === limit) { hasMore = true; break; }
				const index = Math.min(...hits.map(hit => hit!.index)), offset = Math.max(0, [...note.text.slice(0, index)].length - 64);
				matches.push({ scope, path, text: [...note.text].slice(offset, offset + 256).join(""), offset, version: note.version });
			} catch (error) { warnings.push(`${path}: ${String(error)}`); }
		}
		return { matches, hasMore, warnings };
	}
	async list(scope: MemoryScope): Promise<string[]> {
		const root = this.root(scope), paths: string[] = [];
		await this.noSymlink(root);
		let visited = 0;
		const visit = async (directory: string) => {
			let entries;
			try { entries = await this.files.readdir(join(root, directory), { withFileTypes: true }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				if (++visited > 1000) throw new Error("Memory directory exceeds the 1000-entry scan budget; read by path");
				const path = directory ? `${directory}/${entry.name}` : entry.name;
				if (entry.isDirectory()) await visit(path);
				else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
			}
		};
		await visit(""); return paths.sort();
	}
	async revision(scope: MemoryScope, path: string): Promise<string | null> {
		await this.checkPath(scope, path);
		try { const info = await this.files.lstat(this.file(scope, path)); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
		catch (error) { if (missing(error)) return null; throw error; }
	}
	async checkLinks(scope: MemoryScope, text: string): Promise<{ text: string; warnings: string[]; references: string[] }> {
		const warnings: string[] = [], lines: string[] = [], references: string[] = [];
		for (const line of text.split("\n")) {
			let broken = false;
			for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
				const target = match[1]!.split("#")[0]!;
				if (!target || /^https?:\/\//.test(target)) continue;
				references.push(target);
				try { await this.checkPath(scope, target); if (!(await this.files.lstat(this.file(scope, target))).isFile()) throw new Error("not a file"); }
				catch { warnings.push(`${scope}/${target}: link unavailable; repair MEMORY.md`); broken = true; }
			}
			lines.push(broken ? "[Memory link unavailable; read current files and repair this index entry.]" : line);
		}
		return { text: lines.join("\n"), warnings, references };
	}
	async pinned(scope: MemoryScope): Promise<string[]> {
		await this.noSymlink(this.root(scope));
		const path = join(this.root(scope), ".pins.json"); await this.noSymlink(path);
		try {
			if ((await this.files.lstat(path)).size > 8192) throw new Error("Pinned memory list exceeds resource limit");
			const pins: unknown = JSON.parse(await this.files.readFile(path, "utf8"));
			if (!Array.isArray(pins) || pins.length > 20 || pins.some(value => typeof value !== "string")) throw new Error("Invalid pinned memory list");
			for (const pin of pins) this.file(scope, pin);
			return pins;
		} catch (error) { if (missing(error)) return []; throw error; }
	}
	async pin(scope: MemoryScope, path: string, enabled: boolean): Promise<void> {
		this.file(scope, path);
		await this.noSymlink(this.root(scope));
		await memoryLock(this.root(scope), async () => {
			if (enabled) await this.read(scope, path);
			const pins = new Set(await this.pinned(scope));
			if (enabled) pins.add(path); else pins.delete(path);
			if (pins.size > 20 || JSON.stringify([...pins]).length > 8192) throw new Error("Pinned memory list exceeds resource limit");
			await this.atomic(join(this.root(scope), ".pins.json"), JSON.stringify([...pins]));
		}, undefined, this.files);
	}
	private root(scope: MemoryScope): string {
		const root = Object.hasOwn(this.roots, scope) ? this.roots[scope] : undefined;
		if (!root) throw new Error(`Memory scope is not authorized: ${scope}`);
		return root;
	}
	private file(scope: MemoryScope, path: string): string {
		const root = this.root(scope);
		if (!path || path.includes("\\") || path.includes("\0") || !path.endsWith(".md") || path.split("/").some(part => !part || part === ".." || part.startsWith("."))) throw new Error("Invalid memory path");
		const file = resolve(root, path);
		if (!file.startsWith(root + sep)) throw new Error("Memory path escapes its scope");
		return file;
	}
}
