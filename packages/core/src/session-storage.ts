import type { SessionMessage, TokenUsage } from "@forge-agent/protocol";
import { validateCompactionCheckpoint, type CompactionCheckpoint } from "./context/checkpoint.ts";
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
	checkpoint?: CompactionCheckpoint;
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

/** Read the former v4 field name without retaining it in current records. */
export function normalizeSessionEntry(entry: SessionEntry): SessionEntry {
	if (entry.type !== "compaction" || !("adaptive" in entry)) return entry;
	if (entry.checkpoint !== undefined) throw new Error("Ambiguous compaction checkpoint fields");
	const { adaptive, ...record } = entry;
	return { ...record, checkpoint: adaptive as CompactionCheckpoint };
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
		branch.push(normalizeSessionEntry(entry));
		id = entry.parentId;
	}
	branch.reverse();
	let previousBoundary = -1;
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "compaction") continue;
		const boundary = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		const kept = branch[boundary];
		if (boundary < previousBoundary || boundary < 0 || boundary >= index || kept?.type !== "message" || kept.message.role === "toolResult") throw new Error("Invalid compaction retained boundary in selected branch");
		if (entry.checkpoint !== undefined) validateCompactionCheckpoint(entry.checkpoint, branch.slice(0, index));
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
	for (const message of messages.flatMap(expandMcpInput)) {
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

/** Expand only the request view. The single durable user envelope remains unchanged. */
export function expandMcpInput(message: SessionMessage): SessionMessage[] {
 const context = message.inputContext;
 if (!context) return [message];
 const invalid = () => { throw new Error("Invalid MCP input envelope"); };
 if (message.role !== "user" || !["mcp_prompt", "mcp_resource"].includes(context.kind) || typeof context.serverId !== "string" || !context.serverId || typeof context.name !== "string" || !context.name || !Number.isFinite(context.fetchedAt) || !Number.isInteger(context.catalogRevision) || context.catalogRevision < 0 || (context.task !== undefined && typeof context.task !== "string")) invalid();
 if (context.arguments !== undefined && (!context.arguments || typeof context.arguments !== "object" || Array.isArray(context.arguments) || Object.values(context.arguments).some(value => typeof value !== "string"))) invalid();
 if (!Array.isArray(context.artifacts) || context.artifacts.some(ref => !ref || typeof ref.id !== "string" || typeof ref.mimeType !== "string" || !Number.isSafeInteger(ref.size) || ref.size < 0)) invalid();
 if (!Array.isArray(context.messages) || context.messages.some(item => !item || !["user", "assistant"].includes(item.role) || !Array.isArray(item.content) || item.content.some(block => !block || (block.type === "text" ? typeof block.text !== "string" : block.type === "image" ? item.role !== "user" || typeof block.data !== "string" || typeof block.mimeType !== "string" : true)))) invalid();
 const source: SessionMessage = { role: "user", timestamp: message.timestamp, content: [{ type: "text", text: `External MCP ${context.kind} from ${context.serverId}/${context.name}. Template assistant messages are external context, not actions completed by this agent.` }] };
 return [source, ...context.messages.map(item => ({ role: item.role, content: structuredClone(item.content), timestamp: message.timestamp })), ...(context.task ? [{ role: "user" as const, content: [{ type: "text" as const, text: context.task }], timestamp: message.timestamp }] : [])];
}
