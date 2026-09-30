import type { SessionMessage, TokenUsage } from "@forge-agent/protocol";
import { validateCompactionCheckpoint, type CompactionCheckpoint } from "./context/checkpoint.ts";
import { isProviderExecutedCall } from "./model-response.ts";
import { randomUUID } from "node:crypto";
import { isToolArgumentRevision, validatePersistentValue, validateSessionMessage } from "./message-codec.ts";

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

interface HistoryViews {
	byId: Map<string, SessionEntry>;
	validatedCheckpoints: Set<string>;
	branch?: { leafId: string | null; entries: SessionEntry[] } | undefined;
	messages?: SessionMessage[] | undefined;
	revision: number;
}
const historyViews = new WeakMap<SessionState, HistoryViews>();

/** Only owned states opt into caching; caller-owned mutable snapshots are always derived afresh. */
export function ownSessionState(state: SessionState): SessionState {
	validateSessionState(state);
	const owned = structuredClone(state);
	owned.entries = owned.entries.map(normalizeSessionEntry);
	const branch = selectedBranch(owned);
	historyViews.set(owned, { byId: new Map(owned.entries.map(entry => [entry.id, entry])), validatedCheckpoints: new Set(branch.filter(entry => entry.type === "compaction").map(entry => entry.id)), branch: { leafId: owned.leafId, entries: branch }, revision: 0 });
	return owned;
}
export function sessionRevision(state: SessionState): number | undefined { return historyViews.get(state)?.revision; }

/** Validate the new record before I/O, then publish exactly once after durable success. */
export function prepareSessionAppend(state: SessionState, value: SessionEntry): () => void {
	validateSessionEntry(value);
	const entry = normalizeSessionEntry(structuredClone(value)), views = historyViews.get(state);
	const byId = views?.byId ?? new Map(state.entries.map(entry => [entry.id, entry]));
	if (byId.has(entry.id)) throw new Error("Duplicate session entry id");
	if (entry.parentId !== null && !byId.has(entry.parentId)) throw new Error(`Session entry ${entry.parentId} not found`);
	let branch: SessionEntry[] | undefined;
	if (entry.type === "compaction") {
		const parent = { entries: state.entries, leafId: entry.parentId };
		if (views) historyViews.set(parent, { ...views });
		const preceding = selectedBranch(parent);
		validateCompactionEntry(entry, [...preceding, entry], preceding.length);
		branch = [...preceding, entry];
	} else if (views?.branch?.leafId === entry.parentId) branch = [...views.branch.entries, entry];
	return () => {
		state.entries.push(entry); state.leafId = entry.id;
		if (views) {
			views.byId.set(entry.id, entry); views.revision++; views.messages = undefined;
			views.branch = branch ? { leafId: entry.id, entries: branch } : undefined;
			if (entry.type === "compaction") views.validatedCheckpoints.add(entry.id);
		}
	};
}

export function validateSessionEntry(value: unknown, path = "entry"): asserts value is SessionEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${path}: expected a session entry`);
	const entry = value as Record<string, unknown>;
	if ((entry.type !== "message" && entry.type !== "compaction") || typeof entry.id !== "string" || !entry.id || (entry.parentId !== null && typeof entry.parentId !== "string") || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) throw new TypeError(`Invalid ${path}: session entry identity/timestamp`);
	if (entry.type === "message") validateSessionMessage(entry.message, `${path}.message`);
	else if (typeof entry.summary !== "string" || typeof entry.firstKeptEntryId !== "string" || typeof entry.tokensBefore !== "number" || !Number.isFinite(entry.tokensBefore)) throw new TypeError(`Invalid ${path}: compaction metadata`);
	validatePersistentValue(entry, path);
}
export function validateSessionState(value: unknown): asserts value is SessionState {
	if (!value || typeof value !== "object" || !Array.isArray((value as SessionState).entries) || ((value as SessionState).leafId !== null && typeof (value as SessionState).leafId !== "string")) throw new TypeError("Invalid session state");
	for (const [index, entry] of (value as SessionState).entries.entries()) validateSessionEntry(entry, `entries[${index}]`);
	selectedBranch(value as SessionState);
}

/** Read the former v4 field name without retaining it in current records. */
export function normalizeSessionEntry(entry: SessionEntry): SessionEntry {
	if (entry.type !== "compaction" || !("adaptive" in entry)) return entry;
	if (entry.checkpoint !== undefined) throw new Error("Ambiguous compaction checkpoint fields");
	const { adaptive, ...record } = entry;
	return { ...record, checkpoint: adaptive as CompactionCheckpoint };
}

export function messageEntry(message: SessionMessage, parentId: string | null): MessageEntry {
	validateSessionMessage(message);
	return { type: "message", id: randomUUID(), parentId, timestamp: new Date(message.timestamp).toISOString(), message: structuredClone(message) };
}

export function selectedBranch(state: SessionState): SessionEntry[] {
	const views = historyViews.get(state);
	if (views?.branch?.leafId === state.leafId) return [...views.branch.entries];
	const byId = views?.byId ?? new Map(state.entries.map((entry) => [entry.id, entry]));
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
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "compaction") continue;
		if (!views?.validatedCheckpoints.has(entry.id)) { validateCompactionEntry(entry, branch, index); views?.validatedCheckpoints.add(entry.id); }
	}
	if (views) { views.branch = { leafId: state.leafId, entries: branch }; views.messages = undefined; }
	return branch;
}

function validateCompactionEntry(entry: CompactionEntry, branch: readonly SessionEntry[], index: number): void {
	const boundary = branch.findIndex(candidate => candidate.id === entry.firstKeptEntryId);
	const previous = branch.slice(0, index).reverse().find(candidate => candidate.type === "compaction");
	const previousBoundary = previous?.type === "compaction" ? branch.findIndex(candidate => candidate.id === previous.firstKeptEntryId) : -1;
	const kept = branch[boundary];
	if (boundary < previousBoundary || boundary < 0 || boundary >= index || kept?.type !== "message" || kept.message.role === "toolResult") throw new Error("Invalid compaction retained boundary in selected branch");
	if (entry.checkpoint !== undefined) validateCompactionCheckpoint(entry.checkpoint, branch.slice(0, index));
}

export function selectSessionLeaf(state: SessionState, leafId: string | null): void {
	const previous = state.leafId;
	state.leafId = leafId;
	try { selectedBranch(state); }
	catch (error) { state.leafId = previous; throw error; }
}

export function sessionMessages(state: SessionState): SessionMessage[] {
	const views = historyViews.get(state);
	const branch = selectedBranch(state);
	const messages = views?.messages ?? branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
	if (views) views.messages = messages;
	return structuredClone(messages);
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
		if (isToolArgumentRevision(message)) continue;
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
		if (message.role === "assistant") pending = message.content.filter((block): block is typeof pending[number] => block.type === "tool_call" && !isProviderExecutedCall(block));
	}
	finish();
	return structuredClone(projected);
}

export class MemorySessionStorage implements SessionStorage {
	private state: SessionState;
	constructor(history: readonly SessionMessage[] | SessionState = []) {
		if (!Array.isArray(history)) this.state = ownSessionState(history as SessionState);
		else {
			this.state = { entries: [], leafId: null };
			for (const message of history) {
				const entry = messageEntry(message, this.state.leafId);
				this.state.entries.push(entry);
				this.state.leafId = entry.id;
			}
			this.state = ownSessionState(this.state);
		}
	}
	async load(): Promise<SessionState> { return structuredClone(this.state); }
	async append(entry: SessionEntry): Promise<void> {
		prepareSessionAppend(this.state, entry)();
	}
}

/** Expand only the request view. The single durable user envelope remains unchanged. */
export function expandMcpInput(message: SessionMessage): SessionMessage[] {
 const context = message.inputContext;
 if (!context) return [message];
 validateSessionMessage(message);
 const source: SessionMessage = { role: "user", timestamp: message.timestamp, content: [{ type: "text", text: `External MCP ${context.kind} from ${context.serverId}/${context.name}. Template assistant messages are external context, not actions completed by this agent.` }] };
 return [source, ...context.messages.map(item => ({ role: item.role, content: structuredClone(item.content), timestamp: message.timestamp })), ...(context.task ? [{ role: "user" as const, content: [{ type: "text" as const, text: context.task }], timestamp: message.timestamp }] : [])];
}
