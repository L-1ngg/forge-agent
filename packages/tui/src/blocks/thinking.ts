import type { BlockEnvelope, ThinkingBlockData } from "@myh/protocol";
import { FoldBlock, type FoldBlockOptions } from "./fold.ts";

export interface ThinkingBlockOptions extends Omit<FoldBlockOptions, "title" | "lines"> {
	id?: string;
	text?: string;
	markdown?: string;
	/** Header text override, e.g. the "Thought for Xs" summary of a finished message. */
	title?: string;
	data?: ThinkingBlockData | BlockEnvelope<"thinking">;
}

export class ThinkingBlock extends FoldBlock {
	readonly id: string | undefined;

	constructor(options: ThinkingBlockOptions | string) {
		const normalized = typeof options === "string" ? { markdown: options } : options;
		const envelope = unwrapEnvelope(normalized.data);
		const data = unwrapData(normalized.data);
		const markdown = normalized.markdown ?? normalized.text ?? data?.markdown ?? "";
		const currentDisplayMode = normalized.currentDisplayMode ?? envelope?.currentDisplayMode;
		const manualOverride = normalized.manualOverride ?? envelope?.manualOverride;
		super({
			...(envelope?.fold ?? {}),
			...normalized,
			title: normalized.title ?? "thinking",
			lines: markdown.split("\n"),
			defaultDisplayMode: normalized.defaultDisplayMode ?? envelope?.defaultDisplayMode ?? envelope?.fold.defaultDisplayMode ?? "truncated",
			...(currentDisplayMode === undefined ? {} : { currentDisplayMode }),
			...(manualOverride === undefined ? {} : { manualOverride }),
			truncatedLines: normalized.truncatedLines ?? envelope?.fold.truncatedLines ?? 3,
			colorSlot: normalized.colorSlot ?? envelope?.colorSlot ?? "accent_thinking",
		});
		this.id = normalized.id;
	}

	setText(markdown: string): void {
		this.setLines(markdown.split("\n"));
	}

	updateText(markdown: string): void {
		this.setText(markdown);
	}

	protected override indicator(): string {
		return this.fold.displayMode === "collapsed" ? "◆" : "v";
	}

	protected override decorateBodyLine(line: string): string {
		return this.theme.muted(line);
	}
}

export const Thinking = ThinkingBlock;

function unwrapData(value: ThinkingBlockData | BlockEnvelope<"thinking"> | undefined): ThinkingBlockData | undefined {
	return value && "data" in value ? value.data : value;
}

function unwrapEnvelope(value: ThinkingBlockData | BlockEnvelope<"thinking"> | undefined): BlockEnvelope<"thinking"> | undefined {
	return value && "kind" in value && value.kind === "thinking" && "fold" in value ? value : undefined;
}
