import { expandMcpInput } from "./session-storage.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import { normalizeSessionEntry, ownSessionState, prepareSessionAppend, selectSessionLeaf, selectedBranch, sessionMessages, validateSessionEntry, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
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
	const lines: number[] = [];
	const diagnostics: SessionDiagnostic[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		try { records.push(JSON.parse(line)); lines.push(index + 1); }
		catch { diagnostics.push({ line: index + 1, message: "Skipped malformed JSON record" }); }
	}
	const header = records.shift() as SessionHeader | undefined;
	lines.shift();
	if (!header || header.type !== "session" || (header.version !== 4 && !(allowOld && (header.version as number) === 3)) || typeof header.id !== "string" || typeof header.timestamp !== "string" || typeof header.cwd !== "string") throw new Error("Session file must start with a valid v4 session header; convert older sessions to a separate copy");
	if (diagnostics.some((diagnostic) => diagnostic.line === 1)) throw new Error("Invalid session header");
	const entries = records as SessionEntry[];
	const ids = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		validateSessionEntry(entry, `line ${lines[index]} entry`);
		if (ids.has(entry.id)) throw new Error(`Duplicate session entry id at line ${lines[index]}`);
		ids.add(entry.id);
	}
	return { header, entries: entries.map(normalizeSessionEntry), diagnostics, appendable: diagnostics.length === 0 && text.endsWith("\n") };
}

export class SessionStore implements SessionStorage {
	private state: SessionState;
	private writing: Promise<void> = Promise.resolve();
	private faulted = false;
	private persisted = false;
	private constructor(readonly path: string, readonly header: SessionHeader, entries: SessionEntry[], readonly diagnostics: readonly SessionDiagnostic[] = [], readonly appendable = true, leafId?: string | null) {
		this.state = ownSessionState({ entries, leafId: leafId !== undefined ? leafId : entries.at(-1)?.id ?? null });
	}
	/** Prepare a new session without touching the filesystem until its first append. */
	static create(path: string, cwd: string, id: string = randomUUID()): SessionStore {
		return new SessionStore(path, { type: "session", version: 4, id, cwd, timestamp: new Date().toISOString() }, []);
	}
	/** A file was successfully opened or written; not a live filesystem existence check. */
	get saved(): boolean { return this.persisted; }
	static async open(path: string, cwd: string, options: SessionOpenOptions = {}): Promise<SessionStore> {
		try {
			const parsed = parseSession(await readFile(path, "utf8"));
			for (const diagnostic of parsed.diagnostics) options.onDiagnostic?.(diagnostic);
			const store = new SessionStore(path, parsed.header, parsed.entries, parsed.diagnostics, parsed.appendable, options.leafId);
			store.validateBranch();
			store.persisted = true;
			return store;
		} catch (error) {
			if (options.create === false) throw error;
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
			const store = SessionStore.create(path, cwd);
			await store.writeRecords([]);
			return store;
		}
	}
	static async convertCopy(source: string, target: string, cwd: string, options: SessionOpenOptions = {}): Promise<SessionStore> {
		if (resolve(source) === resolve(target)) throw new Error("Conversion requires a distinct target");
		const parsed = parseSession(await readFile(source, "utf8"), true);
		for (const diagnostic of parsed.diagnostics) options.onDiagnostic?.(diagnostic);
		const header: SessionHeader = { ...parsed.header, version: 4 };
		const copy = new SessionStore(target, header, parsed.entries, [], true, options.leafId);
		copy.validateBranch();
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, [header, ...parsed.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
		copy.persisted = true;
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
		selectSessionLeaf(this.state, parentId);
	}
	currentBranch(): SessionEntry[] { return structuredClone(selectedBranch(this.state)); }
	messages(): SessionMessage[] { return sessionMessages(this.state); }
	async load(): Promise<SessionState> { this.validateBranch(); return structuredClone(this.state); }
	append(entry: SessionEntry): Promise<void> {
		const saved = structuredClone(entry);
		const writing = this.writing.then(async () => {
			validateSessionEntry(saved);
			if (this.faulted) throw new Error("Session storage is faulted; reopen a verified copy");
			if (!this.appendable) throw new Error("Session requires an appendable copy; use SessionStore.convertCopy");
			const publish = prepareSessionAppend(this.state, saved);
			try { await this.writeRecords([saved]); }
			catch (error) { this.faulted = true; throw error; }
			publish();
		});
		this.writing = writing.catch(() => {});
		return writing;
	}
	private async writeRecords(entries: readonly SessionEntry[]): Promise<void> {
		if (this.persisted) {
			await appendFile(this.path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", "utf8");
			return;
		}
		await mkdir(dirname(this.path), { recursive: true });
		this.header.timestamp = new Date().toISOString();
		await writeFile(this.path, [this.header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
		this.persisted = true;
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
