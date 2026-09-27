import { dirname, join, resolve, sep } from "node:path";
import { memoryFiles, missing, type MemoryFileSystem } from "./files.ts";

export type MemoryScope = "user" | "project";
export interface MemorySource { kind: "management" | "session"; timestamp: string; sessionId?: string; entryId?: string; location?: string; scope?: MemoryScope; scopeRoot?: string; }
export interface MemoryWrite { scope: MemoryScope; path: string; content: string; }
export interface MemoryRead { scope: MemoryScope; path: string; text: string; modifiedAt: string; sources: MemorySource[]; warnings: string[]; nextOffset?: number; }
export interface MemoryCommit { saved: boolean; deleted?: boolean; scope: MemoryScope; path: string; }
export const MEMORY_FILE_BYTES = 256 * 1024;
export const MEMORY_PAGE_CHARS = 4096;

/** Bound directories are authoritative; Markdown content cannot select another scope. */
export class LongTermMemory {
	readonly roots: Readonly<Partial<Record<MemoryScope, string>>>;
	constructor(roots: Readonly<Partial<Record<MemoryScope, string>>>, private readonly files: MemoryFileSystem = memoryFiles) {
		this.roots = Object.freeze({ ...roots });
		for (const root of Object.values(roots)) if (resolve(root) !== root) throw new Error("Memory roots must be absolute normalized paths");
	}
	async read(scope: MemoryScope, path: string, offset = 0, limit = MEMORY_PAGE_CHARS): Promise<MemoryRead> {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_PAGE_CHARS) throw new Error("Invalid memory page");
		const { text, modifiedAt } = await this.readFull(scope, path);
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
		else warnings.push("Source pointers are not verified here; external edits do not reverify sources");
		if (text.startsWith("---\n")) {
			const end = text.indexOf("\n---", 4);
			if (end < 0) warnings.push("Invalid optional frontmatter; raw text preserved");
			else { try { Bun.YAML.parse(text.slice(4, end)); } catch { warnings.push("Invalid optional frontmatter; raw text preserved"); } }
		}
		return { scope, path, text: chars.slice(offset, offset + limit).join(""), modifiedAt, sources, warnings, ...(offset + limit < chars.length ? { nextOffset: offset + limit } : {}) };
	}
	async readText(scope: MemoryScope, path: string): Promise<string> { return (await this.readFull(scope, path)).text; }
	async write(input: MemoryWrite, source: MemorySource): Promise<MemoryCommit> {
		if (typeof input.content !== "string") throw new Error("Memory content must be Markdown text");
		const file = this.file(input.scope, input.path);
		const content = `${input.content}\n\n<!-- forge-memory-source ${JSON.stringify({ ...source, scope: input.scope, scopeRoot: this.root(input.scope) })} -->\n`;
		if (Buffer.byteLength(content) > MEMORY_FILE_BYTES) throw new Error("Memory write exceeds 256 KiB resource limit");
		await this.checkPath(input.scope, input.path);
		await this.files.mkdir(dirname(file), { recursive: true });
		await this.files.writeFile(file, content, "utf8");
		return { saved: true, scope: input.scope, path: input.path };
	}
	async delete(scope: MemoryScope, path: string): Promise<MemoryCommit> {
		await this.checkPath(scope, path);
		await this.files.unlink(this.file(scope, path));
		return { saved: false, deleted: true, scope, path };
	}
	private async readFull(scope: MemoryScope, path: string): Promise<{ text: string; modifiedAt: string }> {
		await this.checkPath(scope, path);
		const handle = await this.files.open(this.file(scope, path), "r");
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new Error("Memory path is not a regular file");
			if (info.size > MEMORY_FILE_BYTES) throw new Error("Memory file exceeds 256 KiB resource limit");
			const bytes = Buffer.alloc(MEMORY_FILE_BYTES + 1);
			let length = 0;
			while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
			if (length > MEMORY_FILE_BYTES) throw new Error("Memory file exceeds 256 KiB resource limit");
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
			if (text.includes("\0")) throw new Error("Memory file is not readable text (NUL bytes)");
			return { text, modifiedAt: info.mtime.toISOString() };
		} finally { await handle.close(); }
	}
	async search(scope: MemoryScope, query: string, limit = 10, signal?: AbortSignal) {
		if (!query.trim() || [...query].length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Invalid memory search query or limit");
		const words = query.trim().split(/\s+/u);
		if (words.length > 8) throw new Error("Memory search allows at most 8 words");
		const patterns = words.map(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
		const matches: Array<{ path: string; text: string; offset: number; scope: MemoryScope }> = [];
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
				matches.push({ scope, path, text: [...note.text].slice(offset, offset + 256).join(""), offset });
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
			catch (error) { if (missing(error)) return; throw error; }
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
		if (enabled) await this.read(scope, path);
		const pins = new Set(await this.pinned(scope));
		if (enabled) pins.add(path); else pins.delete(path);
		if (pins.size > 20 || JSON.stringify([...pins]).length > 8192) throw new Error("Pinned memory list exceeds resource limit");
		await this.files.mkdir(this.root(scope), { recursive: true });
		await this.files.writeFile(join(this.root(scope), ".pins.json"), JSON.stringify([...pins]));
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
	private async noSymlink(path: string) {
		try { if ((await this.files.lstat(path)).isSymbolicLink()) throw new Error("Memory symlinks are not authorized"); }
		catch (error) { if (!missing(error)) throw error; }
	}
	private async checkPath(scope: MemoryScope, path: string) {
		this.file(scope, path);
		let current = this.root(scope); await this.noSymlink(current);
		for (const part of path.split("/")) { current = join(current, part); await this.noSymlink(current); }
	}
}
