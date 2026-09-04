import type { AnyBlockEnvelope, SessionEvent } from "@myh/protocol";
import { Container, Markdown, type Component, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { componentForBlock, updateBlockComponent } from "./blocks/index.ts";
import { FoldBlock } from "./blocks/fold.ts";
import { ThinkingBlock } from "./blocks/thinking.ts";
import { formatDurationMs, formatTimeHHMM, type TimeFormatter } from "./blocks/message.ts";
import { identityTheme, markdownThemeFromSlots, type SemanticTheme } from "./theme.ts";
import { EntryShell } from "./transcript/entry-shell.ts";
import type { EntryChrome, TranscriptEntry } from "./transcript/types.ts";
import { TranscriptProjector, thinkingEntryId, type StreamedContentBlock } from "./transcript/projector.ts";

export type ContentBlock = StreamedContentBlock;

export interface StreamRendererOptions {
	theme?: SemanticTheme;
	formatTime?: TimeFormatter;
	/** Effective compact mode. A callback keeps transcript chrome in sync with resize. */
	compact?: boolean | (() => boolean);
}

export interface StreamRendererEntrySpan {
	entryId: string;
	start: number;
	height: number;
	logicalLineStarts: readonly number[];
	lastContentRow: number;
}

/**
 * Component projection over one canonical TranscriptProjector. The projector
 * owns event order and identity; this class owns only reusable pi-tui bodies,
 * shells and fold state.
 */
export class StreamRenderer extends Container {
	private readonly projector = new TranscriptProjector();
	private readonly richComponents = new Map<string, Component>();
	private readonly entryShells = new Map<string, EntryShell>();
	private readonly thinkingIndex = new Map<string, ThinkingBlock>();
	private readonly thinkingFoldToEntry = new Map<string, string>();
	private readonly theme: SemanticTheme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly formatTime: TimeFormatter;
	private readonly compact: () => boolean;
	private visibleEntryIds: string[] = [];

	constructor(options: StreamRendererOptions = {}) {
		super();
		this.theme = options.theme ?? identityTheme;
		this.markdownTheme = markdownThemeFromSlots(this.theme);
		this.formatTime = options.formatTime ?? formatTimeHHMM;
		this.compact = typeof options.compact === "function" ? options.compact : () => options.compact === true;
	}

	apply(event: SessionEvent): void {
		this.projector.apply(event);
		this.syncChildren();
	}

	/** Append a muted one-line notice at the current end of the transcript. */
	addNotice(text: string): void {
		this.projector.addNotice(text);
		this.syncChildren();
	}

	getEvents(): SessionEvent[] {
		return this.projector.getEvents();
	}

	getOrderedBlocks(): readonly ContentBlock[] {
		return this.projector.getOrderedBlocks();
	}

	getRichBlocks(): readonly AnyBlockEnvelope[] {
		return this.projector.getTools().flatMap((tool) => tool.block === undefined ? [] : [structuredClone(tool.block)]);
	}

	getEntries(): TranscriptEntry[] {
		return this.projector.getEntries();
	}

	/** Stable UI-local entry identities in the current paint order. */
	getEntryIds(): readonly string[] {
		return [...this.visibleEntryIds];
	}

	/** Exact top-level row spans for scroll anchoring at the supplied width. */
	getEntrySpans(width: number): readonly StreamRendererEntrySpan[] {
		const spans: StreamRendererEntrySpan[] = [];
		let start = 0;
		for (const entryId of this.visibleEntryIds) {
			const shell = this.entryShells.get(entryId);
			if (!shell) continue;
			const height = shell.render(width).length;
			const anchorRows = shell.getAnchorRows(width);
			spans.push({ entryId, start, height, ...anchorRows });
			start += height;
		}
		return spans;
	}

	/** Expose the canonical projection for integration/golden tests. */
	getProjector(): TranscriptProjector {
		return this.projector;
	}

	toggleBlock(id: string): boolean {
		const canonicalId = this.thinkingFoldToEntry.get(id) ?? id;
		const component = this.richComponents.get(id) ?? this.thinkingIndex.get(id) ?? this.thinkingIndex.get(canonicalId);
		if (component instanceof FoldBlock) {
			component.toggle();
			this.projector.setEntryDisplayState(canonicalId, component.displayMode, component.manualOverride);
			this.syncChildren();
			return true;
		}
		return false;
	}

	getBlockComponent(id: string): Component | undefined {
		const canonicalId = this.thinkingFoldToEntry.get(id) ?? id;
		return this.richComponents.get(id) ?? this.thinkingIndex.get(id) ?? this.thinkingIndex.get(canonicalId);
	}

	/** Return the newest structured block that can be manually folded. */
	latestFoldableBlockId(): string | undefined {
		for (const entry of [...this.projector.getEntries()].reverse()) {
			if (entry.kind === "thinking") {
				const foldId = this.thinkingFoldToEntry.get(entry.id) ?? this.foldIdForThinkingEntry(entry.id);
				const component = this.getBlockComponent(foldId);
				if (component instanceof FoldBlock) return foldId;
				continue;
			}
			if (entry.kind === "execute" || entry.kind === "edit") {
				const component = this.richComponents.get(entry.block.id);
				if (component instanceof FoldBlock) return entry.block.id;
			}
		}
		return undefined;
	}

	toggleLatestBlock(): boolean {
		const id = this.latestFoldableBlockId();
		return id === undefined ? false : this.toggleBlock(id);
	}

	clear(): void {
		this.projector.clear();
		this.richComponents.clear();
		this.entryShells.clear();
		this.thinkingIndex.clear();
		this.thinkingFoldToEntry.clear();
		this.visibleEntryIds = [];
		super.clear();
	}

	private syncChildren(): void {
		const nextChildren: Component[] = [];
		for (const entry of this.projector.getEntries()) {
			const component = this.componentForEntry(entry);
			if (component) nextChildren.push(component);
		}
		this.clearChildrenOnly();
		for (const child of nextChildren) this.addChild(child);
		this.visibleEntryIds = nextChildren
			.filter((child): child is EntryShell => child instanceof EntryShell && child.id !== undefined)
			.map((child) => child.id as string);
	}

	private clearChildrenOnly(): void {
		const children = [...this.children];
		for (const child of children) this.removeChild(child);
	}

	private componentForEntry(entry: TranscriptEntry): EntryShell | undefined {
		switch (entry.kind) {
			case "user":
				return this.messageShell(entry.id, entry.text, this.formatTime(entry.timestamp ?? 0), { surface: "surface", showPrefix: true, vpadTop: this.compact() ? 0 : 1, vpadBottom: this.compact() ? 0 : 1 });
			case "assistant": {
				const body = new Markdown(entry.markdown, 0, 0, this.markdownTheme);
				return this.messageShell(entry.id, body, entry.timestamp === undefined ? undefined : this.formatTime(entry.timestamp), {});
			}
			case "thinking": {
				const component = this.thinkingComponent(entry.id, entry);
				return this.messageShell(entry.id, component, undefined, this.thinkingChrome(component, entry.block.lifecycle === "streaming"));
			}
			case "execute":
			case "edit": {
				const component = this.syncRichComponent(entry.block);
				return this.messageShell(entry.id, component, undefined, this.richChrome(entry.block, component));
			}
			case "notice":
				return this.messageShell(entry.id, new Text(this.theme[entry.tone](entry.text), 0, 0), undefined, { collapsed: true });
		}
	}

	private messageShell(id: string, value: string | Component, timestamp: string | undefined, overrides: Partial<EntryChrome>): EntryShell {
		const chrome: EntryChrome = {
			vpadTop: 0,
			vpadBottom: 0,
			...(timestamp === undefined ? {} : { timestamp }),
			...overrides,
		};
		const existing = this.entryShells.get(id);
		if (existing) {
			existing.setBody(typeof value === "string" ? undefined : value);
			existing.setText(typeof value === "string" ? value : undefined);
			existing.setChrome(chrome);
			return existing;
		}
		const shell = new EntryShell({ id, theme: this.theme, ...(typeof value === "string" ? { text: value } : { body: value }), chrome });
		this.entryShells.set(id, shell);
		return shell;
	}

	private thinkingComponent(id: string, entry: Extract<TranscriptEntry, { kind: "thinking" }>): ThinkingBlock {
		this.foldIdForThinkingEntry(id);
		const existing = this.thinkingIndex.get(id);
		const markdown = entry.block.kind === "thinking" ? entry.block.data.markdown : "";
		const duration = entry.durationMs;
		const title = entry.block.lifecycle === "streaming" ? "Thinking…" : duration === undefined || duration < 100 ? "Thought" : `Thought for ${formatDurationMs(duration)}`;
		if (existing) {
			existing.setLines(markdown.split("\n"), entry.block.lifecycle === "streaming" ? "expanded" : "collapsed");
			existing.setTitle(title);
			return existing;
		}
		const component = new ThinkingBlock({ data: entry.block.kind === "thinking" ? entry.block : { markdown }, title, theme: this.theme });
		this.thinkingIndex.set(id, component);
		return component;
	}

	private foldIdForThinkingEntry(entryId: string): string {
		const message = this.projector.getMessageForEntry(entryId);
		const content = message?.content.find((value) => value.entry.id === entryId);
		const foldId = message === undefined || content === undefined ? entryId : thinkingEntryId(message.seq, content.index);
		this.thinkingFoldToEntry.set(foldId, entryId);
		return foldId;
	}

	private syncRichComponent(block: AnyBlockEnvelope): Component {
		const previous = this.richComponents.get(block.id);
		const component = previous ? updateBlockComponent(previous, block) : componentForBlock(block, this.theme);
		this.richComponents.set(block.id, component);
		return component;
	}

	private thinkingChrome(component: ThinkingBlock, streaming: boolean): Partial<EntryChrome> {
		const collapsed = component.displayMode === "collapsed";
		return { collapsed, contentPrefix: "◆ ", contentPrefixTone: collapsed ? "muted" : streaming ? "dim" : "accent_tool", ...(collapsed ? {} : { rail: "dim" as const }) };
	}

	private richChrome(block: AnyBlockEnvelope, component: Component): Partial<EntryChrome> {
		const collapsed = component instanceof FoldBlock && component.displayMode === "collapsed";
		return { collapsed, contentPrefix: "◆ ", contentPrefixTone: this.richBulletTone(block, collapsed), ...this.richRail(block) };
	}

	private richBulletTone(block: AnyBlockEnvelope, collapsed: boolean): NonNullable<EntryChrome["contentPrefixTone"]> {
		if (block.kind === "execute") {
			if (block.lifecycle === "failed" || block.data.isError) return "accent_error";
			return block.lifecycle === "streaming" ? "accent_running" : "accent_success";
		}
		if (block.kind === "edit" && block.lifecycle === "failed") return "accent_error";
		if (block.kind === "thinking") return collapsed ? "muted" : block.lifecycle === "streaming" ? "dim" : "accent_tool";
		return collapsed ? "muted" : "accent_tool";
	}

	private richRail(block: AnyBlockEnvelope): Pick<EntryChrome, "rail"> | Record<string, never> {
		if (block.kind === "thinking") return { rail: "dim" };
		if (block.kind === "execute") {
			if (block.lifecycle === "failed" || block.data.isError) return { rail: "accent_error" };
			return { rail: block.lifecycle === "streaming" ? "accent_running" : "accent_success" };
		}
		if (block.kind === "edit") return {};
		return { rail: "accent_tool" };
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
