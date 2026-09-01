import type { BlockEnvelope, ThinkingBlockData } from "@myh/protocol";
import { FoldBlock, type FoldBlockOptions } from "./fold.ts";

export interface ThinkingBlockOptions extends Omit<FoldBlockOptions, "title" | "lines"> {
	id?: string;
	text?: string;
	markdown?: string;
	data?: ThinkingBlockData | BlockEnvelope<"thinking">;
}

export class ThinkingBlock extends FoldBlock {
	readonly id: string | undefined;

	constructor(options: ThinkingBlockOptions | string) {
		const normalized = typeof options === "string" ? { markdown: options } : options;
		const data = unwrapData(normalized.data);
		const markdown = normalized.markdown ?? normalized.text ?? data?.markdown ?? "";
		super({ ...normalized, title: "thinking", lines: markdown.split("\n"), defaultDisplayMode: normalized.defaultDisplayMode ?? "truncated", truncatedLines: normalized.truncatedLines ?? 3 });
		this.id = normalized.id;
	}

	setText(markdown: string): void {
		this.setLines(markdown.split("\n"));
	}

	updateText(markdown: string): void {
		this.setText(markdown);
	}
}

export const Thinking = ThinkingBlock;

function unwrapData(value: ThinkingBlockData | BlockEnvelope<"thinking"> | undefined): ThinkingBlockData | undefined {
		return value && "data" in value ? value.data : value;
}
