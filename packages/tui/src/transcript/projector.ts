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

export interface StreamedContentBlock {
	kind: "text" | "thinking" | "tool_call";
	text: string;
}

export interface ProjectedContent {
	readonly index: number;
	readonly entry: TranscriptEntry;
	readonly source?: SessionContentBlock;
	readonly streamText: string;
}

export interface ProjectedMessage {
	readonly seq: number;
	readonly role: SessionMessage["role"];
	readonly timestamp: number;
	readonly complete: boolean;
	readonly toolCallId?: string;
	readonly content: readonly ProjectedContent[];
}

export interface ProjectedTool {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args?: Record<string, unknown>;
	readonly executed: boolean;
	readonly block?: AnyBlockEnvelope;
	readonly entryId?: string;
}

interface MutableContent {
	index: number;
	entryId: string;
	source?: SessionContentBlock;
	streamText: string;
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
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	executed: boolean;
	block?: AnyBlockEnvelope;
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
	private readonly events: SessionEvent[] = [];
	private readonly messages: MessageProjection[] = [];
	private readonly tools = new Map<string, ToolProjection>();
	private readonly standaloneToolOrder: string[] = [];
	private readonly notices: NoticeProjection[] = [];
	private readonly rootTimeline: RootTimelineItem[] = [];
	private readonly displayState = new Map<string, DisplayState>();
	private active: MessageProjection | undefined;
	private messageSeq = 0;
	private noticeSeq = 0;
	private turnStartedAt: number | undefined;
	private lastCompletedFingerprint: MessageFingerprint | undefined;

	apply(event: SessionEvent): void {
		this.events.push(structuredClone(event));
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
				return;
			case "turn_start":
				this.turnStartedAt = event.timestamp;
				return;
			case "turn_end":
				this.endTurn(event.timestamp);
				return;
			default:
				return;
		}
	}

	addNotice(text: string): string {
		const id = `notice-${this.noticeSeq++}`;
		this.notices.push({ id, text });
		this.rootTimeline.push({ kind: "notice", id });
		return id;
	}

	getEvents(): SessionEvent[] {
		return structuredClone(this.events);
	}

	getEntries(): TranscriptEntry[] {
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
					const entry = this.entryForContent(message, content, anchoredTools);
					if (entry) entries.push(entry);
				}
				continue;
			}
			if (item.kind === "tool") {
				if (anchoredTools.has(item.toolCallId)) continue;
				const tool = this.tools.get(item.toolCallId);
				if (tool?.block) entries.push(this.applyDisplayState(toolEntry(toolEntryId(item.toolCallId), tool.block)));
				continue;
			}
			const notice = noticeById.get(item.id);
			if (notice) entries.push({ id: notice.id, kind: "notice", text: notice.text, tone: "muted" });
		}
		return entries;
	}

	getEntry(id: string): TranscriptEntry | undefined {
		return this.getEntries().find((entry) => entry.id === id);
	}

	getEntryIds(): readonly string[] {
		return this.getEntries().map((entry) => entry.id);
	}

	getMessages(): ProjectedMessage[] {
		const visible = new Map(this.getEntries().map((entry) => [entry.id, entry]));
		return this.messages.map((message) => ({
			seq: message.seq,
			role: message.role,
			timestamp: message.timestamp,
			complete: message.complete,
			...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
			content: [...message.content.values()]
				.sort((left, right) => left.index - right.index)
				.flatMap((content) => {
					const entry = visible.get(content.entryId);
					return entry === undefined ? [] : [{
						index: content.index,
						entry: structuredClone(entry),
						...(content.source === undefined ? {} : { source: structuredClone(content.source) }),
						streamText: content.streamText,
					}];
				}),
		}));
	}

	getMessageForEntry(id: string): ProjectedMessage | undefined {
		return this.getMessages().find((message) => message.content.some((content) => content.entry.id === id));
	}

	getTool(toolCallId: string): ProjectedTool | undefined {
		const tool = this.tools.get(toolCallId);
		if (!tool) return undefined;
		return {
			toolCallId,
			toolName: tool.toolName,
			...(tool.args === undefined ? {} : { args: structuredClone(tool.args) }),
			executed: tool.executed,
			...(tool.block === undefined ? {} : { block: this.blockWithDisplayState(toolCallId, tool.block) }),
			entryId: this.anchorForTool(toolCallId) ?? toolEntryId(toolCallId),
		};
	}

	getTools(): ProjectedTool[] {
		return [...this.tools.keys()].map((id) => this.getTool(id) as ProjectedTool);
	}

	getOrderedBlocks(): StreamedContentBlock[] {
		if (!this.active) return [];
		return [...this.active.content.values()]
			.sort((left, right) => left.index - right.index)
			.filter((content) => content.source !== undefined && content.streamText.length > 0)
			.map((content) => ({
				kind: content.source?.type === "text" ? "text" : content.source?.type === "thinking" ? "thinking" : "tool_call",
				text: content.streamText,
			}));
	}

	setEntryDisplayState(id: string, currentDisplayMode: BlockDisplayMode, manualOverride: boolean): void {
		this.displayState.set(id, { currentDisplayMode, manualOverride });
		const toolCallId = this.toolCallIdForEntry(id);
		if (toolCallId) this.displayState.set(toolCallId, { currentDisplayMode, manualOverride });
	}

	clear(): void {
		this.events.length = 0;
		this.messages.length = 0;
		this.tools.clear();
		this.standaloneToolOrder.length = 0;
		this.notices.length = 0;
		this.rootTimeline.length = 0;
		this.displayState.clear();
		this.active = undefined;
		this.messageSeq = 0;
		this.noticeSeq = 0;
		this.turnStartedAt = undefined;
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
		const streamText = (previous?.streamText ?? "") + event.delta;
		if (event.contentType === "thinking" && !message.thinkingStartedAt.has(event.contentIndex)) message.thinkingStartedAt.set(event.contentIndex, event.timestamp);
		const source: SessionContentBlock = event.contentType === "text"
			? { type: "text", text: streamText }
			: event.contentType === "thinking"
				? { type: "thinking", thinking: streamText }
				: { type: "tool_call", id: `pending-${message.seq}-${event.contentIndex}`, name: "tool", arguments: {} };
		message.content.set(event.contentIndex, {
			index: event.contentIndex,
			entryId: previous?.entryId ?? messageEntryId(message.seq, event.contentIndex),
			source,
			streamText,
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
		message.role = value.role;
		message.timestamp = value.timestamp;
		message.complete = complete;
		if (value.toolCallId === undefined) delete message.toolCallId;
		else message.toolCallId = value.toolCallId;
		const nextIndexes = new Set<number>();
		for (const [index, source] of value.content.entries()) {
			nextIndexes.add(index);
			const previous = message.content.get(index);
			const streamText = source.type === "text" ? source.text : source.type === "thinking" ? source.thinking : previous?.streamText ?? "";
			const startedAt = message.thinkingStartedAt.get(index);
			const durationMs = source.type === "thinking" && complete && startedAt !== undefined && eventTimestamp >= startedAt ? eventTimestamp - startedAt : undefined;
			message.content.set(index, {
				index,
				entryId: previous?.entryId ?? messageEntryId(message.seq, index),
				source: structuredClone(source),
				streamText,
				...(durationMs === undefined ? {} : { durationMs }),
			});
		}
		if (!preserveMissing) {
			for (const index of [...message.content.keys()]) if (!nextIndexes.has(index)) message.content.delete(index);
		}
	}

	private applyTool(toolCallId: string, toolName: string, args: Record<string, unknown> | undefined, value: AnyBlockEnvelope | undefined): void {
		const tool = this.tools.get(toolCallId) ?? { toolCallId, toolName, executed: false };
		tool.toolName = toolName;
		tool.executed = true;
		if (args !== undefined) tool.args = structuredClone(args);
		if (value !== undefined) tool.block = structuredClone(value);
		this.tools.set(toolCallId, tool);
		if (!this.standaloneToolOrder.includes(toolCallId)) {
			this.standaloneToolOrder.push(toolCallId);
			this.rootTimeline.push({ kind: "tool", toolCallId });
		}
		if (value !== undefined) this.reconcileIncomingDisplayState(toolCallId, value);
	}

	private entryForContent(message: MessageProjection, content: MutableContent, anchoredTools: Set<string>): TranscriptEntry | undefined {
		const source = content.source;
		if (!source) return undefined;
		if (message.role === "toolResult" && message.toolCallId && this.tools.get(message.toolCallId)?.block?.kind === "execute") return undefined;
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
		if (tool?.block) return this.applyDisplayState(toolEntry(content.entryId, this.blockWithDisplayState(source.id, tool.block)));
		if (tool?.executed) return { id: content.entryId, kind: "notice", text: compactToolPreview(source.name, tool.args ?? source.arguments), tone: "muted" };
		return { id: content.entryId, kind: "notice", text: message.complete ? `${source.name} tool call` : "Calling tool…", tone: "muted" };
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
		if (!state) return entry;
		entry.block.currentDisplayMode = state.currentDisplayMode;
		entry.block.manualOverride = state.manualOverride;
		return entry;
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
		if (value.fold.respectManualFolds === false) {
			for (const key of keys) this.displayState.delete(key);
			return;
		}
		if (value.manualOverride === true && value.currentDisplayMode !== undefined) {
			const state: DisplayState = {
				currentDisplayMode: value.currentDisplayMode,
				manualOverride: true,
			};
			for (const key of keys) this.displayState.set(key, state);
		}
	}

	private anchorForTool(toolCallId: string): string | undefined {
		for (const message of this.messages) {
			for (const content of message.content.values()) if (content.source?.type === "tool_call" && content.source.id === toolCallId) return content.entryId;
		}
		return undefined;
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
		this.addNotice(`Worked for ${formatDuration(startedAt, timestamp)}`);
	}
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

function compactToolPreview(name: string, value: unknown): string {
	let encoded: string;
	try {
		encoded = JSON.stringify(value) ?? String(value);
	} catch {
		encoded = String(value);
	}
	const preview = `${name}(${encoded})`;
	return preview.length > 96 ? `${preview.slice(0, 95)}…` : preview;
}

function formatDuration(start: number, end: number): string {
	const seconds = Math.max(0, end - start) / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}
