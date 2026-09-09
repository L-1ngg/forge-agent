import type { SessionMessage } from "@forge-agent/protocol";
import { selectedBranch, sessionMessages, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type { SessionEntry } from "./session-storage.ts";
export interface SessionHeader {
	type: "session";
	version: 4;
	id: string;
	timestamp: string;
	cwd: string;
}
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
}

export interface SessionDiagnostic { line: number; message: string; }
export interface SessionOpenOptions { create?: boolean; leafId?: string | null; onDiagnostic?: (diagnostic: SessionDiagnostic) => void; }

function parseSession(text: string, allowOld = false): { header: SessionHeader; entries: SessionEntry[]; diagnostics: SessionDiagnostic[]; appendable: boolean } {
	const records: unknown[] = [];
	const diagnostics: SessionDiagnostic[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		try { records.push(JSON.parse(line)); }
		catch { diagnostics.push({ line: index + 1, message: "Skipped malformed JSON record" }); }
	}
	const header = records.shift() as SessionHeader | undefined;
	if (!header || header.type !== "session" || (header.version !== 4 && !(allowOld && Number(header.version) === 3)) || typeof header.id !== "string" || typeof header.timestamp !== "string" || typeof header.cwd !== "string") throw new Error("Session file must start with a valid v4 session header; convert older sessions to a separate copy");
	if (diagnostics.some((diagnostic) => diagnostic.line === 1)) throw new Error("Invalid session header");
	const entries = records as SessionEntry[];
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry || (entry.type !== "message" && entry.type !== "compaction") || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || (entry.parentId !== null && typeof entry.parentId !== "string") || typeof entry.timestamp !== "string") throw new Error("Session contains an invalid entry");
		if (entry.type === "message" && (!entry.message || !["user", "assistant", "toolResult"].includes(entry.message.role) || !Array.isArray(entry.message.content))) throw new Error("Invalid session message");
		if (entry.type === "compaction" && (typeof entry.summary !== "string" || typeof entry.firstKeptEntryId !== "string" || !Number.isFinite(entry.tokensBefore))) throw new Error("Invalid compaction record");
		ids.add(entry.id);
	}
	return { header, entries, diagnostics, appendable: diagnostics.length === 0 && text.endsWith("\n") };
}

export class SessionStore implements SessionStorage {
	private state: SessionState;
	private writing: Promise<void> = Promise.resolve();
	private faulted = false;
	private constructor(readonly path: string, readonly header: SessionHeader, entries: SessionEntry[], readonly diagnostics: readonly SessionDiagnostic[] = [], readonly appendable = true) {
		this.state = { entries, leafId: entries.at(-1)?.id ?? null };
	}
	static async open(path: string, cwd: string, options: SessionOpenOptions = {}): Promise<SessionStore> {
		try {
			const parsed = parseSession(await readFile(path, "utf8"));
			for (const diagnostic of parsed.diagnostics) options.onDiagnostic?.(diagnostic);
			const store = new SessionStore(path, parsed.header, parsed.entries, parsed.diagnostics, parsed.appendable);
			if (options.leafId !== undefined) store.state.leafId = options.leafId;
			store.validateBranch();
			return store;
		} catch (error) {
			if (options.create === false) throw error;
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
			await mkdir(dirname(path), { recursive: true });
			const header: SessionHeader = { type: "session", version: 4, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
			await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
			return new SessionStore(path, header, []);
		}
	}
	static async convertCopy(source: string, target: string, cwd: string, options: SessionOpenOptions = {}): Promise<SessionStore> {
		if (resolve(source) === resolve(target)) throw new Error("Conversion requires a distinct target");
		const parsed = parseSession(await readFile(source, "utf8"), true);
		for (const diagnostic of parsed.diagnostics) options.onDiagnostic?.(diagnostic);
		const header: SessionHeader = { ...parsed.header, version: 4 };
		const copy = new SessionStore(target, header, parsed.entries);
		if (options.leafId !== undefined) copy.state.leafId = options.leafId;
		copy.validateBranch();
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, [header, ...parsed.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
		return copy;
	}
	private validateBranch(): void {
		selectedBranch(this.state);
	}
	getLeafId(): string | null { return this.state.leafId; }
	getEntries(): SessionEntry[] { return structuredClone(this.state.entries); }
	getEntry(id: string): SessionEntry | undefined {
		const entry = this.state.entries.find((entry) => entry.id === id);
		return entry ? structuredClone(entry) : undefined;
	}
	branch(parentId: string | null): void {
		selectedBranch({ ...this.state, leafId: parentId });
		this.state.leafId = parentId;
		this.validateBranch();
	}
	currentBranch(): SessionEntry[] { return structuredClone(selectedBranch(this.state)); }
	messages(): SessionMessage[] { return sessionMessages(this.state); }
	async load(): Promise<SessionState> { this.validateBranch(); return structuredClone(this.state); }
	asStorage(): SessionStorage { return this; }
	append(entry: SessionEntry): Promise<void> {
		const saved = structuredClone(entry);
		const writing = this.writing.then(async () => {
			if (this.faulted) throw new Error("Session storage is faulted; reopen a verified copy");
			if (!this.appendable) throw new Error("Session requires an appendable copy; use SessionStore.convertCopy");
			if (this.state.entries.some((existing) => existing.id === saved.id)) throw new Error("Duplicate session entry id");
			selectedBranch({ entries: [...this.state.entries, saved], leafId: saved.id });
			try { await appendFile(this.path, `${JSON.stringify(saved)}\n`, "utf8"); }
			catch (error) { this.faulted = true; throw error; }
			this.state.entries.push(saved);
			this.state.leafId = saved.id;
		});
		this.writing = writing.catch(() => {});
		return writing;
	}
	getTree(): SessionTreeNode[] {
		const nodes = new Map(this.state.entries.map((entry) => [entry.id, { entry: structuredClone(entry), children: [] as SessionTreeNode[] }]));
		const roots: SessionTreeNode[] = [];
		for (const entry of this.state.entries) {
			const node = nodes.get(entry.id)!;
			if (entry.parentId === null) roots.push(node);
			else nodes.get(entry.parentId)?.children.push(node);
		}
		return roots;
	}
}
