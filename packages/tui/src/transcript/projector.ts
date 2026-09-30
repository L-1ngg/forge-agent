import {
	block,
	type AnyBlockEnvelope,
	type BlockDisplayMode,
	type SessionContentBlock,
	type SessionEvent,
	type SessionMessage,
} from "@forge-agent/protocol";
import type { TranscriptEntry } from "./types.ts";
import { messageEntryId, thinkingEntryId, toolEntryId } from "./identity.ts";

export { contentIndexFromMessageEntryId, messageEntryId, thinkingEntryId, toolEntryId } from "./identity.ts";

interface MutableContent {
	index: number;
	entryId: string;
	source?: SessionContentBlock;
	durationMs?: number;
}

interface MessageProjection {
	seq: number;
	role: SessionMessage["role"];
	timestamp: number;
	complete: boolean;
	implicit: boolean;
	toolCallId?: string;
	content: Map<number, MutableContent>;
	thinkingStartedAt: Map<number, number>;
}

interface MessageFingerprint {
	role: SessionMessage["role"];
	timestamp: number;
	toolCallId?: string;
	content: string;
}

interface ToolProjection {
	revision: number;
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	block?: AnyBlockEnvelope;
	content?: string;
	lifecycle?: "streaming" | "complete" | "failed";
}

interface NoticeProjection {
	id: string;
	text: string;
}

type RootTimelineItem =
	| { kind: "message"; seq: number }
	| { kind: "tool"; toolCallId: string }
	| { kind: "notice"; id: string };

interface DisplayState {
	currentDisplayMode: BlockDisplayMode;
	manualOverride: boolean;
}

/** Canonical UI-local reducer for transcript identity, ordering and de-duplication. */
export class TranscriptProjector {
	private revision = 0;
	private snapshot: { revision: number; entries: readonly TranscriptEntry[] } | undefined;
	private readonly entryCache = new Map<string, { key: readonly unknown[]; entry: TranscriptEntry }>();
	private readonly entryById = new Map<string, TranscriptEntry>();
	private readonly toolAnchors = new Map<string, string>();
	private readonly messages: MessageProjection[] = [];
	private readonly tools = new Map<string, ToolProjection>();
	private readonly notices: NoticeProjection[] = [];
	private readonly rootTimeline: RootTimelineItem[] = [];
	private readonly displayState = new Map<string, DisplayState>();
	private active: MessageProjection | undefined;
	private messageSeq = 0;
	private noticeSeq = 0;
	private turnStartedAt: number | undefined;
	private executionFailed = false;
	private lastCompletedFingerprint: MessageFingerprint | undefined;

	apply(event: SessionEvent): void {
		if (["message_start", "message_delta", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_end"].includes(event.type)) this.revision++;
		switch (event.type) {
			case "message_start":
				this.startMessage(event.message);
				return;
			case "message_delta":
				this.applyDelta(event);
				return;
			case "message_end":
				this.endMessage(event.message, event.timestamp);
				return;
			case "tool_execution_start":
				this.applyTool(event.toolCallId, event.toolName, event.args, event.block);
				return;
			case "tool_execution_update":
			case "tool_execution_end":
				this.applyTool(event.toolCallId, event.toolName, undefined, event.block);
				this.tools.get(event.toolCallId)!.content = event.content;
				this.tools.get(event.toolCallId)!.lifecycle = event.type === "tool_execution_update" ? "streaming" : event.isError ? "failed" : "complete";
				return;
			case "agent_start":
				this.turnStartedAt = event.timestamp;
				this.executionFailed = false;
				return;
			case "turn_end":
				this.executionFailed = event.stopReason === "error" || event.stopReason === "aborted";
				return;
			case "agent_end":
				this.endTurn(event.timestamp);
				return;
			default:
				return;
		}
	}

	addNotice(text: string): string {
		this.revision++;
		const id = `notice-${this.noticeSeq++}`;
		this.notices.push({ id, text });
		this.rootTimeline.push({ kind: "notice", id });
		return id;
	}

	getEntries(): TranscriptEntry[] {
		return structuredClone(this.getSnapshot().entries) as TranscriptEntry[];
	}
	/** Immutable derived entries shared by all readers in a frame. */
	getSnapshot(): { readonly revision: number; readonly entries: readonly TranscriptEntry[] } {
		if (this.snapshot?.revision === this.revision) return this.snapshot;
		// Compute anchors before walking the root timeline. A tool can arrive
		// before its assistant message; once that message is known, its
		// standalone placeholder must disappear rather than duplicate the block.
		const anchoredTools = new Set<string>();
		for (const message of this.messages) {
			for (const content of message.content.values()) {
				if (content.source?.type === "tool_call") anchoredTools.add(content.source.id);
			}
		}
		const entries: TranscriptEntry[] = [];
		const messageBySeq = new Map(this.messages.map((message) => [message.seq, message]));
		const noticeById = new Map(this.notices.map((notice) => [notice.id, notice]));
		for (const item of this.rootTimeline) {
			if (item.kind === "message") {
				const message = messageBySeq.get(item.seq);
				if (!message) continue;
				for (const content of [...message.content.values()].sort((left, right) => left.index - right.index)) {
					const tool = content.source?.type === "tool_call" ? this.tools.get(content.source.id) : undefined;
					const key = [message.role, message.timestamp, message.complete, message.toolCallId, content.source, content.durationMs, tool?.revision, this.displayState.get(content.entryId), tool ? this.displayState.get(tool.toolCallId) : undefined];
					const entry = this.cachedEntry(content.entryId, key, () => this.entryForContent(message, content, anchoredTools));
					if (entry) entries.push(entry);
				}
				continue;
			}
			if (item.kind === "tool") {
				if (anchoredTools.has(item.toolCallId)) continue;
				const tool = this.tools.get(item.toolCallId);
				if (tool) entries.push(this.cachedEntry(toolEntryId(item.toolCallId), [tool.revision, this.displayState.get(item.toolCallId)], () => this.toolEntry(toolEntryId(item.toolCallId), tool))!);
				continue;
			}
			const notice = noticeById.get(item.id);
			if (notice) entries.push(this.cachedEntry(notice.id, [notice.text], () => ({ id: notice.id, kind: "notice", text: notice.text, tone: "muted" }))!);
		}
		this.entryById.clear();
		for (const entry of entries) this.entryById.set(entry.id, entry);
		for (const id of this.entryCache.keys()) if (!this.entryById.has(id)) this.entryCache.delete(id);
		this.snapshot = Object.freeze({ revision: this.revision, entries: Object.freeze(entries) });
		return this.snapshot;
	}
	private cachedEntry(id: string, key: readonly unknown[], build: () => TranscriptEntry | undefined): TranscriptEntry | undefined {
		const cached = this.entryCache.get(id);
		if (cached && key.length === cached.key.length && key.every((value, index) => value === cached.key[index])) return cached.entry;
		const entry = build();
		if (entry) { freezeEntry(entry); this.entryCache.set(id, { key, entry }); }
		return entry;
	}

	getEntry(id: string): TranscriptEntry | undefined {
		this.getSnapshot();
		const entry = this.entryById.get(id);
		return entry ? structuredClone(entry) : undefined;
	}

	getEntryIds(): readonly string[] {
		return this.getSnapshot().entries.map((entry) => entry.id);
	}

	setEntryDisplayState(id: string, currentDisplayMode: BlockDisplayMode, manualOverride: boolean): void {
		this.revision++;
		this.displayState.set(id, { currentDisplayMode, manualOverride });
		const toolCallId = this.toolCallIdForEntry(id);
		if (toolCallId) this.displayState.set(toolCallId, { currentDisplayMode, manualOverride });
	}

	clear(): void {
		this.revision++; this.snapshot = undefined; this.entryCache.clear(); this.entryById.clear(); this.toolAnchors.clear();
		this.messages.length = 0;
		this.tools.clear();
		this.notices.length = 0;
		this.rootTimeline.length = 0;
		this.displayState.clear();
		this.active = undefined;
		this.messageSeq = 0;
		this.noticeSeq = 0;
		this.turnStartedAt = undefined;
		this.executionFailed = false;
		this.lastCompletedFingerprint = undefined;
	}

	private startMessage(message: SessionMessage): void {
		if (this.matchesLastCompleted(message)) return;
		const implicit = this.active?.implicit === true && !this.active.complete && this.active.role === message.role
			? this.active
			: undefined;
		const projection = implicit ?? this.createMessage(message.role, message.timestamp, message.toolCallId);
		projection.implicit = false;
		this.active = projection;
		this.reconcileMessage(projection, message, false, message.timestamp, implicit !== undefined);
	}

	private applyDelta(event: Extract<SessionEvent, { type: "message_delta" }>): void {
		const message = this.active ?? this.createImplicitAssistant(event.timestamp);
		const previous = message.content.get(event.contentIndex);
		if (event.contentType === "thinking" && !message.thinkingStartedAt.has(event.contentIndex)) message.thinkingStartedAt.set(event.contentIndex, event.timestamp);
		const source: SessionContentBlock = event.contentType === "text"
			? { type: "text", text: (previous?.source?.type === "text" ? previous.source.text : "") + event.delta }
			: event.contentType === "thinking"
				? { type: "thinking", thinking: (previous?.source?.type === "thinking" ? previous.source.thinking : "") + event.delta }
				: { type: "tool_call", id: `pending-${message.seq}-${event.contentIndex}`, name: "tool", arguments: {} };
		message.content.set(event.contentIndex, {
			index: event.contentIndex,
			entryId: previous?.entryId ?? messageEntryId(message.seq, event.contentIndex),
			source,
		});
	}

	private endMessage(value: SessionMessage, eventTimestamp: number): void {
		if (!this.active && this.matchesLastCompleted(value)) return;
		let message = this.active && !this.active.complete && this.active.role === value.role ? this.active : undefined;
		if (!message) message = [...this.messages].reverse().find((candidate) => !candidate.complete && candidate.role === value.role);
		if (!message) message = this.createMessage(value.role, value.timestamp, value.toolCallId);
		this.reconcileMessage(message, value, true, eventTimestamp);
		this.lastCompletedFingerprint = fingerprint(value);
		if (this.active === message) this.active = undefined;
	}

	private reconcileMessage(message: MessageProjection, value: SessionMessage, complete: boolean, eventTimestamp: number, preserveMissing = false): void {
		if (value.inputContext) value = { ...value, content: [{ type: "text", text: `${value.inputContext.task ?? ""}\n[MCP ${value.inputContext.serverId}/${value.inputContext.name}]` }] };
		if (value.role === "toolResult" && value.toolCallId) {
			this.applyTool(value.toolCallId, value.toolName ?? this.tools.get(value.toolCallId)?.toolName ?? "tool", undefined, undefined);
			const tool = this.tools.get(value.toolCallId)!;
			tool.content = value.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			tool.lifecycle = complete ? value.isError ? "failed" : "complete" : "streaming";
		}
		message.role = value.role;
		message.timestamp = value.timestamp;
		message.complete = complete;
		if (value.toolCallId === undefined) delete message.toolCallId;
		else message.toolCallId = value.toolCallId;
		const nextIndexes = new Set<number>();
		for (const [index, source] of value.content.entries()) {
			nextIndexes.add(index);
			const previous = message.content.get(index);
			if (previous?.source?.type === "tool_call" && (source.type !== "tool_call" || source.id !== previous.source.id) && this.toolAnchors.get(previous.source.id) === previous.entryId) this.toolAnchors.delete(previous.source.id);
			const startedAt = message.thinkingStartedAt.get(index);
			const durationMs = source.type === "thinking" && complete && startedAt !== undefined && eventTimestamp >= startedAt ? eventTimestamp - startedAt : undefined;
			message.content.set(index, {
				index,
				entryId: previous?.entryId ?? messageEntryId(message.seq, index),
				source: structuredClone(source),
				...(durationMs === undefined ? {} : { durationMs }),
			});
			if (source.type === "tool_call") this.toolAnchors.set(source.id, message.content.get(index)!.entryId);
		}
		if (!preserveMissing) {
			for (const [index, previous] of message.content) if (!nextIndexes.has(index)) {
				if (previous.source?.type === "tool_call" && this.toolAnchors.get(previous.source.id) === previous.entryId) this.toolAnchors.delete(previous.source.id);
				message.content.delete(index);
			}
		}
	}

	private applyTool(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined, value: AnyBlockEnvelope | undefined): void {
		const existing = this.tools.get(toolCallId);
		const tool = existing ?? { toolCallId, toolName, revision: this.revision };
		tool.revision = this.revision;
		tool.toolName = toolName;
		if (args !== undefined) tool.args = structuredClone(args);
		if (value !== undefined) tool.block = structuredClone(value);
		this.tools.set(toolCallId, tool);
		if (!existing) this.rootTimeline.push({ kind: "tool", toolCallId });
		if (value !== undefined) this.reconcileIncomingDisplayState(toolCallId, value);
	}

	private entryForContent(message: MessageProjection, content: MutableContent, anchoredTools: Set<string>): TranscriptEntry | undefined {
		const source = content.source;
		if (!source) return undefined;
		if (message.role === "toolResult" && message.toolCallId) return undefined;
		if (source.type === "image") return { id: content.entryId, kind: "user", text: `[image: ${source.mimeType}]`, timestamp: message.timestamp };
		if (source.type === "text") {
			if (source.text.length === 0) return undefined;
			return message.role === "user"
				? { id: content.entryId, kind: "user", text: source.text, timestamp: message.timestamp }
				: { id: content.entryId, kind: "assistant", markdown: source.text, timestamp: message.timestamp, lifecycle: message.complete ? "complete" : "streaming" };
		}
		if (source.type === "thinking") {
			return this.applyDisplayState({
				id: content.entryId,
				kind: "thinking",
				block: block(
					{ id: content.entryId, kind: "thinking", lifecycle: message.complete ? "complete" : "streaming" },
					{ markdown: source.thinking },
					{ defaultDisplayMode: message.complete ? "collapsed" : "expanded" },
				),
				...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
			});
		}
		anchoredTools.add(source.id);
		const tool = this.tools.get(source.id);
		return this.toolEntry(content.entryId, { toolCallId: source.id, revision: this.revision, ...tool, toolName: source.name }, source.arguments);
	}

	private createMessage(role: SessionMessage["role"], timestamp: number, toolCallId?: string, implicit = false): MessageProjection {
		const message: MessageProjection = {
			seq: this.messageSeq++,
			role,
			timestamp,
			complete: false,
			implicit,
			...(toolCallId === undefined ? {} : { toolCallId }),
			content: new Map(),
			thinkingStartedAt: new Map(),
		};
		this.messages.push(message);
		this.rootTimeline.push({ kind: "message", seq: message.seq });
		return message;
	}

	private createImplicitAssistant(timestamp: number): MessageProjection {
		const message = this.createMessage("assistant", timestamp, undefined, true);
		this.active = message;
		return message;
	}

	private applyDisplayState<T extends TranscriptEntry>(entry: T): T {
		if (entry.kind !== "thinking" && entry.kind !== "execute" && entry.kind !== "edit") return entry;
		const state = this.displayState.get(entry.id) ?? this.displayState.get(entry.block.id);
		if (!state) {
			if (entry.kind === "execute" || entry.kind === "edit") entry.block.currentDisplayMode = "collapsed";
			return entry;
		}
		entry.block.currentDisplayMode = state.currentDisplayMode;
		entry.block.manualOverride = state.manualOverride;
		return entry;
	}

	private toolEntry(id: string, tool: ToolProjection, args: Record<string, unknown> = {}): TranscriptEntry {
		if (tool.block && (tool.block.kind === "execute" || tool.block.kind === "edit" || tool.block.kind === "thinking")) {
			const value = this.blockWithDisplayState(tool.toolCallId, tool.block);
			if (tool.lifecycle) value.lifecycle = tool.lifecycle;
			const entry = this.applyDisplayState(toolEntry(id, value));
			if ((entry.kind === "execute" || entry.kind === "edit") && tool.content !== undefined) entry.result = tool.content;
			return entry;
		}
		return {
			id, kind: "tool", toolCallId: tool.toolCallId, name: tool.toolName,
			args: structuredClone(tool.args ?? args), content: tool.content ?? "",
			lifecycle: tool.lifecycle ?? "streaming",
			displayMode: (this.displayState.get(id) ?? this.displayState.get(tool.toolCallId))?.currentDisplayMode ?? "collapsed",
		};
	}

	private blockWithDisplayState(id: string, value: AnyBlockEnvelope): AnyBlockEnvelope {
		const copy = structuredClone(value);
		const state = this.displayState.get(id);
		if (state) {
			copy.currentDisplayMode = state.currentDisplayMode;
			copy.manualOverride = state.manualOverride;
		}
		return copy;
	}

	private reconcileIncomingDisplayState(toolCallId: string, value: AnyBlockEnvelope): void {
		const anchor = this.anchorForTool(toolCallId);
		const keys = anchor === undefined ? [toolCallId] : [toolCallId, anchor];
		if (keys.some((key) => this.displayState.get(key)?.manualOverride)) return;
		if (value.manualOverride === true && value.currentDisplayMode !== undefined) {
			const state: DisplayState = {
				currentDisplayMode: value.currentDisplayMode,
				manualOverride: true,
			};
			for (const key of keys) this.displayState.set(key, state);
		}
	}

	private anchorForTool(toolCallId: string): string | undefined {
		return this.toolAnchors.get(toolCallId);
	}

	private toolCallIdForEntry(entryId: string): string | undefined {
		for (const message of this.messages) {
			for (const content of message.content.values()) if (content.entryId === entryId && content.source?.type === "tool_call") return content.source.id;
		}
		if (entryId.startsWith("tool-")) return entryId.slice("tool-".length);
		return undefined;
	}

	private matchesLastCompleted(message: SessionMessage): boolean {
		const previous = this.lastCompletedFingerprint;
		return previous !== undefined
			&& previous.role === message.role
			&& previous.timestamp === message.timestamp
			&& previous.toolCallId === message.toolCallId
			&& previous.content === messageContentFingerprint(message);
	}

	private endTurn(timestamp: number): void {
		const startedAt = this.turnStartedAt;
		this.turnStartedAt = undefined;
		if (startedAt === undefined || timestamp < startedAt) return;
		if (!this.executionFailed) this.addNotice(`Worked for ${formatDuration(startedAt, timestamp)}`);
	}
}

function freezeEntry(value: unknown): void {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeEntry(child);
	Object.freeze(value);
}

function fingerprint(message: SessionMessage): MessageFingerprint {
	return {
		role: message.role,
		timestamp: message.timestamp,
		...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
		content: messageContentFingerprint(message),
	};
}

function messageContentFingerprint(message: SessionMessage): string {
	return JSON.stringify(message.content);
}

function toolEntry(id: string, value: AnyBlockEnvelope): TranscriptEntry {
	if (value.kind === "thinking") return { id, kind: "thinking", block: structuredClone(value) };
	if (value.kind === "execute") return { id, kind: "execute", block: structuredClone(value) };
	if (value.kind === "edit") return { id, kind: "edit", block: structuredClone(value) };
	return { id, kind: "notice", text: value.kind, tone: "muted" };
}

function formatDuration(start: number, end: number): string {
	const seconds = Math.max(0, end - start) / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}
