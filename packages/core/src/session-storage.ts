import type { SessionMessage, TokenUsage } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";

interface EntryIdentity {
	id: string;
	parentId: string | null;
	timestamp: string;
}
export interface MessageEntry extends EntryIdentity {
	type: "message";
	message: SessionMessage;
}
export interface CompactionEntry extends EntryIdentity {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	usage?: TokenUsage;
	details?: { readFiles?: string[]; modifiedFiles?: string[] };
}
export type SessionEntry = MessageEntry | CompactionEntry;
export interface SessionState {
	entries: SessionEntry[];
	leafId: string | null;
}
export interface SessionStorage {
	load(): Promise<SessionState>;
	append(entry: SessionEntry): Promise<void>;
}

export function messageEntry(message: SessionMessage, parentId: string | null): MessageEntry {
	return { type: "message", id: randomUUID(), parentId, timestamp: new Date(message.timestamp).toISOString(), message: structuredClone(message) };
}

export function selectedBranch(state: SessionState): SessionEntry[] {
	const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
	if (byId.size !== state.entries.length) throw new Error("Duplicate session entry id");
	const branch: SessionEntry[] = [];
	const visited = new Set<string>();
	let id = state.leafId;
	while (id !== null) {
		if (visited.has(id)) throw new Error("Session parent cycle");
		visited.add(id);
		const entry = byId.get(id);
		if (!entry) throw new Error(`Session entry ${id} not found`);
		branch.push(entry);
		id = entry.parentId;
	}
	branch.reverse();
	let previousBoundary = -1;
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "compaction") continue;
		const boundary = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		const kept = branch[boundary];
		if (boundary < previousBoundary || boundary < 0 || boundary >= index || kept?.type !== "message" || kept.message.role === "toolResult") throw new Error("Invalid compaction retained boundary in selected branch");
		previousBoundary = boundary;
	}
	return branch;
}

export function sessionMessages(state: SessionState): SessionMessage[] {
	return structuredClone(selectedBranch(state).flatMap((entry) => entry.type === "message" ? [entry.message] : []));
}

/** Missing historical results describe unknown side effects, never authorize replay. */
export function projectMessages(messages: readonly SessionMessage[]): SessionMessage[] {
	const projected: SessionMessage[] = [];
	let pending: Extract<SessionMessage["content"][number], { type: "tool_call" }>[] = [];
	const finish = () => {
		for (const call of pending) projected.push({
			role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: 0, isError: true,
			content: [{ type: "text", text: "Historical tool result is missing. Execution and side effects are unknown. Do not assume success or non-execution." }],
		});
		pending = [];
	};
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (!pending.some((call) => call.id === message.toolCallId)) continue;
			pending = pending.filter((call) => call.id !== message.toolCallId);
			projected.push(message);
			continue;
		}
		finish();
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || message.contextExcluded)) continue;
		if (message.role === "assistant" && message.stopReason === "length") {
			projected.push({ ...message, content: message.content.filter((block) => block.type !== "tool_call") });
			continue;
		}
		projected.push(message);
		if (message.role === "assistant") pending = message.content.filter((block): block is typeof pending[number] => block.type === "tool_call");
	}
	finish();
	return structuredClone(projected);
}

export class MemorySessionStorage implements SessionStorage {
	private state: SessionState;
	constructor(history: readonly SessionMessage[] | SessionState = []) {
		if (!Array.isArray(history)) this.state = structuredClone(history as SessionState);
		else {
			this.state = { entries: [], leafId: null };
			for (const message of history) {
				const entry = messageEntry(message, this.state.leafId);
				this.state.entries.push(entry);
				this.state.leafId = entry.id;
			}
		}
	}
	async load(): Promise<SessionState> { return structuredClone(this.state); }
	async append(entry: SessionEntry): Promise<void> {
		if (this.state.entries.some((existing) => existing.id === entry.id)) throw new Error("Duplicate session entry id");
		if (entry.parentId !== null && !this.state.entries.some((existing) => existing.id === entry.parentId)) throw new Error("Unknown session parent");
		this.state.entries.push(structuredClone(entry));
		this.state.leafId = entry.id;
	}
}
