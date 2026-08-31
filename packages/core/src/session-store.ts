import type { SessionMessage } from "@myh/protocol";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
}

export interface SessionEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: SessionMessage;
}

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
}

function newEntryId(existing: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!existing.has(id)) return id;
	}
	throw new Error("Unable to allocate a unique session entry id");
}

function parseSession(text: string): { header: SessionHeader; entries: SessionEntry[] } {
	const records = text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionHeader | SessionEntry);
	const header = records[0];
	if (!header || header.type !== "session" || header.version !== 3) throw new Error("Session file must start with a v3 session header");
	const entries = records.slice(1) as SessionEntry[];
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || !/^[0-9a-f]{8}$/.test(entry.id)) throw new Error("Session contains an invalid entry");
		if (entry.parentId !== null && !ids.has(entry.parentId)) throw new Error(`Session entry ${entry.id} has an unknown parent`);
		ids.add(entry.id);
	}
	return { header, entries };
}

export class SessionStore {
	readonly path: string;
	readonly header: SessionHeader;
	private readonly entries: SessionEntry[];
	private readonly byId: Map<string, SessionEntry>;
	private leafId: string | null;

	private constructor(path: string, header: SessionHeader, entries: SessionEntry[]) {
		this.path = path;
		this.header = header;
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.leafId = entries.at(-1)?.id ?? null;
	}

	static async open(path: string, cwd: string): Promise<SessionStore> {
		try {
			const parsed = parseSession(await readFile(path, "utf8"));
			return new SessionStore(path, parsed.header, parsed.entries);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
			await mkdir(dirname(path), { recursive: true });
			const header: SessionHeader = {
				type: "session",
				version: 3,
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				cwd,
			};
			await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
			return new SessionStore(path, header, []);
		}
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getEntries(): SessionEntry[] {
		return structuredClone(this.entries);
	}

	getEntry(id: string): SessionEntry | undefined {
		const entry = this.byId.get(id);
		return entry ? structuredClone(entry) : undefined;
	}

	branch(parentId: string | null): void {
		if (parentId !== null && !this.byId.has(parentId)) throw new Error(`Session entry ${parentId} not found`);
		this.leafId = parentId;
	}

	currentBranch(): SessionEntry[] {
		const branch: SessionEntry[] = [];
		let id = this.leafId;
		while (id !== null) {
			const entry = this.byId.get(id);
			if (!entry) throw new Error(`Session entry ${id} not found`);
			branch.push(entry);
			id = entry.parentId;
		}
		return structuredClone(branch.reverse());
	}

	messages(): SessionMessage[] {
		return this.currentBranch().map((entry) => entry.message);
	}

	async appendTurn(messages: readonly SessionMessage[]): Promise<SessionEntry[]> {
		if (messages.length === 0) return [];
		const ids = new Set(this.byId.keys());
		const added: SessionEntry[] = [];
		let parentId = this.leafId;
		for (const message of messages) {
			const id = newEntryId(ids);
			ids.add(id);
			const entry: SessionEntry = {
				type: "message",
				id,
				parentId,
				timestamp: new Date(message.timestamp).toISOString(),
				message: structuredClone(message),
			};
			added.push(entry);
			parentId = id;
		}
		await appendFile(this.path, `${added.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		for (const entry of added) {
			this.entries.push(entry);
			this.byId.set(entry.id, entry);
		}
		this.leafId = parentId;
		return structuredClone(added);
	}

	getTree(): SessionTreeNode[] {
		const nodes = new Map(this.entries.map((entry) => [entry.id, { entry: structuredClone(entry), children: [] as SessionTreeNode[] }]));
		const roots: SessionTreeNode[] = [];
		for (const entry of this.entries) {
			const node = nodes.get(entry.id);
			if (!node) continue;
			if (entry.parentId === null) roots.push(node);
			else nodes.get(entry.parentId)?.children.push(node);
		}
		return roots;
	}
}
