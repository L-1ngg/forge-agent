import type { AnyBlockEnvelope, SessionEvent, SessionMessage } from "@myh/protocol";
import { Container, Markdown, Spacer, type Component, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { componentForBlock, updateBlockComponent } from "./blocks/index.ts";
import { FoldBlock } from "./blocks/fold.ts";
import { ThinkingBlock } from "./blocks/thinking.ts";
import { UserMessageCard, formatDurationMs, formatTimeHHMM, withRightStamp, type TimeFormatter } from "./blocks/message.ts";
import { identityTheme, markdownThemeFromSlots, type SemanticTheme } from "./theme.ts";

interface ContentBlock {
	kind: "text" | "thinking" | "tool_call";
	text: string;
}

interface MessageRecord {
	seq: number;
	message: SessionMessage;
	streamingBlocks: Map<number, ContentBlock>;
	/** First-delta timestamp per thinking contentIndex, for the "Thought for Xs" summary. */
	thinkingStart: Map<number, number>;
	thinkingDuration: Map<number, number>;
	thinkingComponents: Map<number, ThinkingBlock>;
}

type TimelineEntry =
	| { kind: "message"; record: MessageRecord }
	| { kind: "rich"; id: string }
	| { kind: "footer"; text: string };

export interface StreamRendererOptions {
	theme?: SemanticTheme;
	formatTime?: TimeFormatter;
}

/** One blank line between transcript entries; a shared instance is stateless. */
const ENTRY_SPACER = new Spacer(1);

function streamedMessageText(record: MessageRecord): string {
	const streamed = [...record.streamingBlocks.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, block]) => block)
		.map((block) => {
			const prefix = block.kind === "thinking" ? "thinking: " : block.kind === "tool_call" ? "tool: " : "";
			return `${prefix}${block.text}`;
		});
	return streamed.join("\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

export class StreamRenderer extends Container {
	private readonly blocks = new Map<number, ContentBlock>();
	private readonly messages: MessageRecord[] = [];
	private readonly timeline: TimelineEntry[] = [];
	private readonly events: SessionEvent[] = [];
	private readonly richBlocks = new Map<string, AnyBlockEnvelope>();
	private readonly richComponents = new Map<string, Component>();
	private readonly thinkingIndex = new Map<string, ThinkingBlock>();
	private readonly theme: SemanticTheme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly formatTime: TimeFormatter;
	private messageSeq = 0;
	private turnStartedAt: number | undefined;
	private activeMessage: MessageRecord | undefined;

	constructor(options: StreamRendererOptions = {}) {
		super();
		this.theme = options.theme ?? identityTheme;
		this.markdownTheme = markdownThemeFromSlots(this.theme);
		this.formatTime = options.formatTime ?? formatTimeHHMM;
	}

	apply(event: SessionEvent): void {
		this.events.push(event);
		if (event.type === "turn_start") {
			this.turnStartedAt = event.timestamp;
			return;
		}
		if (event.type === "turn_end") {
			const startedAt = this.turnStartedAt;
			this.turnStartedAt = undefined;
			if (startedAt !== undefined && event.timestamp >= startedAt) {
				this.timeline.push({ kind: "footer", text: `Worked for ${formatDurationMs(event.timestamp - startedAt)}` });
				this.syncChildren();
			}
			return;
		}
		if (event.type === "message_start") {
			if (event.message.role === "assistant") this.blocks.clear();
			const record = this.createRecord(event.message);
			this.activeMessage = record;
			this.syncChildren();
			return;
		}
		if (event.type === "message_end") {
			let record = this.activeMessage;
			if (!record || record.message.role !== event.message.role) {
				const current = this.messages.at(-1);
				if (current?.message.role === event.message.role) record = current;
			}
			if (!record) record = this.createRecord(event.message);
			record.message = structuredClone(event.message);
			record.streamingBlocks.clear();
			for (const [index, startedAt] of record.thinkingStart) {
				if (!record.thinkingDuration.has(index) && event.timestamp >= startedAt) record.thinkingDuration.set(index, event.timestamp - startedAt);
			}
			if (this.activeMessage === record) this.activeMessage = undefined;
			if (event.message.role === "assistant") this.blocks.clear();
			this.syncChildren();
			return;
		}
		if (event.type === "message_delta") {
			const record = this.activeMessage ?? this.createImplicitMessage(event.timestamp);
			const current = this.blocks.get(event.contentIndex) ?? { kind: event.contentType, text: "" };
			current.text += event.delta;
			this.blocks.set(event.contentIndex, current);
			record.streamingBlocks.set(event.contentIndex, current);
			if (event.contentType === "thinking" && !record.thinkingStart.has(event.contentIndex)) record.thinkingStart.set(event.contentIndex, event.timestamp);
			this.syncChildren();
			return;
		}
		if (event.type === "tool_execution_end") {
			this.updateRichBlock(event.block);
			this.syncChildren();
			return;
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			this.updateRichBlock(event.block);
			this.syncChildren();
		}
	}

	getEvents(): SessionEvent[] {
		return structuredClone(this.events);
	}

	getOrderedBlocks(): readonly ContentBlock[] {
		return [...this.blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => ({ ...block }));
	}

	getRichBlocks(): readonly AnyBlockEnvelope[] {
		return [...this.richBlocks.values()].map((block) => structuredClone(block));
	}

	toggleBlock(id: string): boolean {
		const component = this.richComponents.get(id);
		if (component instanceof FoldBlock) {
			component.toggle();
			const block = this.richBlocks.get(id);
			if (block) {
				block.currentDisplayMode = component.displayMode;
				block.manualOverride = component.manualOverride;
			}
			return true;
		}
		const thinking = this.thinkingIndex.get(id);
		if (thinking) {
			thinking.toggle();
			return true;
		}
		return false;
	}

	getBlockComponent(id: string): Component | undefined {
		return this.richComponents.get(id);
	}

	/** Return the newest structured block that can be manually folded. */
	latestFoldableBlockId(): string | undefined {
		for (const entry of [...this.timeline].reverse()) {
			if (entry.kind === "rich") {
				if (this.richComponents.get(entry.id) instanceof FoldBlock) return entry.id;
				continue;
			}
			if (entry.kind !== "message") continue;
			const thinkingIds = [...entry.record.thinkingComponents.keys()].reverse();
			if (thinkingIds.length > 0) return `thinking-${entry.record.seq}-${thinkingIds[0]}`;
		}
		return undefined;
	}

	toggleLatestBlock(): boolean {
		const id = this.latestFoldableBlockId();
		return id === undefined ? false : this.toggleBlock(id);
	}

	private syncChildren(): void {
		this.clear();
		let firstEntry = true;
		for (const entry of this.timeline) {
			if (!firstEntry) this.addChild(ENTRY_SPACER);
			firstEntry = false;
			if (entry.kind === "footer") {
				this.addChild(new Text(this.theme.muted(entry.text), 1, 0));
				continue;
			}
			if (entry.kind === "message") {
				this.addMessageChildren(entry.record);
				continue;
			}
			// A block anchored to an assistant tool_call is emitted at that call's
			// position by addMessageChildren. Do not append a second copy here.
			if (this.hasAssistantToolCall(entry.id)) continue;
			const component = this.syncRichComponent(entry.id);
			if (component) this.addChild(component);
		}
	}

	private addMessageChildren(record: MessageRecord): void {
		if (record.streamingBlocks.size > 0) {
			const text = streamedMessageText(record);
			if (text) this.addChild(new Text(text, 1, 0));
			return;
		}

		if (record.message.role === "user") {
			const text = record.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text) this.addChild(new UserMessageCard(text, record.message.timestamp, this.theme, this.formatTime));
			return;
		}

		// An execute projection already carries stdout/stderr, so its protocol
		// tool-result fallback would duplicate the same output. Edit projections
		// only carry the diff and must keep their result summary visible.
		if (record.message.role === "toolResult") {
			if (record.message.toolCallId && this.richBlocks.get(record.message.toolCallId)?.kind === "execute") return;
			const text = record.message.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.filter(Boolean)
				.join("\n");
			if (text) this.addChild(new Text(this.theme.muted(text), 1, 0));
			return;
		}

		let stamped = false;
		for (const [index, block] of record.message.content.entries()) {
			if (block.type === "text") {
				if (!block.text) continue;
				let component: Component = new Markdown(block.text, 1, 0, this.markdownTheme);
				if (!stamped) {
					component = withRightStamp(component, record.message.timestamp, this.theme, this.formatTime);
					stamped = true;
				}
				this.addChild(component);
				continue;
			}
			if (block.type === "thinking") {
				this.addChild(this.thinkingComponent(record, index, block.thinking));
				continue;
			}
			if (this.richBlocks.has(block.id)) {
				const component = this.syncRichComponent(block.id);
				if (component) this.addChild(component);
				continue;
			}
			this.addChild(new Text(this.theme.muted(`${block.name}(${safeJson(block.arguments)})`), 1, 0));
		}
	}

	private thinkingComponent(record: MessageRecord, contentIndex: number, markdown: string): ThinkingBlock {
		const existing = record.thinkingComponents.get(contentIndex);
		const duration = record.thinkingDuration.get(contentIndex);
		const title = duration === undefined ? "Thought" : `Thought for ${formatDurationMs(duration)}`;
		if (existing) {
			existing.setText(markdown);
			existing.setTitle(title);
			return existing;
		}
		const component = new ThinkingBlock({
			markdown,
			title,
			defaultDisplayMode: "collapsed",
			theme: this.theme,
		});
		record.thinkingComponents.set(contentIndex, component);
		this.thinkingIndex.set(`thinking-${record.seq}-${contentIndex}`, component);
		return component;
	}

	private syncRichComponent(id: string): Component | undefined {
		const block = this.richBlocks.get(id);
		if (!block) return undefined;
		const previous = this.richComponents.get(block.id);
		const component = previous ? updateBlockComponent(previous, block) : componentForBlock(block, this.theme);
		this.richComponents.set(block.id, component);
		if (component instanceof FoldBlock) {
			// The component is the local source of truth for a manual fold. Keep
			// the serialized projection aligned so headless/TUI state can compare.
			block.currentDisplayMode = component.displayMode;
			block.manualOverride = component.manualOverride;
			this.richBlocks.set(block.id, block);
		}
		return component;
	}

	private hasAssistantToolCall(id: string): boolean {
		return this.messages.some((record) => record.message.role === "assistant" && record.message.content.some((block) => block.type === "tool_call" && block.id === id));
	}

	private createRecord(message: SessionMessage): MessageRecord {
		const record: MessageRecord = {
			seq: this.messageSeq++,
			message: structuredClone(message),
			streamingBlocks: new Map(),
			thinkingStart: new Map(),
			thinkingDuration: new Map(),
			thinkingComponents: new Map(),
		};
		this.messages.push(record);
		this.timeline.push({ kind: "message", record });
		return record;
	}

	private createImplicitMessage(timestamp: number): MessageRecord {
		const record = this.createRecord({ role: "assistant", content: [], timestamp });
		this.activeMessage = record;
		return record;
	}

	private updateRichBlock(block: AnyBlockEnvelope | undefined): void {
		if (!block) return;
		const copy = structuredClone(block);
		this.richBlocks.set(copy.id, copy);
		if (!this.timeline.some((entry) => entry.kind === "rich" && entry.id === copy.id)) this.timeline.push({ kind: "rich", id: copy.id });
	}
}

export class RendererComponent implements Component {
	constructor(private readonly renderer: StreamRenderer) {}

	render(width: number): string[] {
		return this.renderer.render(width);
	}

	invalidate(): void {
		this.renderer.invalidate();
	}
}
