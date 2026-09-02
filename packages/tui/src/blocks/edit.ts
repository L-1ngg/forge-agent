import type { BlockEnvelope, DiffLine, EditBlockData } from "@myh/protocol";
import { identityTheme, type SemanticTheme } from "../theme.ts";
import { FoldBlock, type FoldBlockOptions } from "./fold.ts";

export interface EditBlockOptions extends Omit<FoldBlockOptions, "title" | "lines"> {
	id?: string;
	path?: string;
	data?: EditBlockData | BlockEnvelope<"edit">;
}

/** Renders already-computed hunks; no diff algorithm belongs in this package. */
export class EditBlock extends FoldBlock {
	readonly id: string | undefined;

	constructor(options: EditBlockOptions | EditBlockData) {
		const normalized = isEditData(options) ? { data: options } : options;
		const envelope = unwrapEnvelope(normalized.data);
		const data = unwrapData(normalized.data);
		if (!data) throw new Error("EditBlock requires diff hunk data");
		const defaultDisplayMode = normalized.defaultDisplayMode ?? envelope?.defaultDisplayMode;
		const currentDisplayMode = normalized.currentDisplayMode ?? envelope?.currentDisplayMode;
		const manualOverride = normalized.manualOverride ?? envelope?.manualOverride;
		const theme = normalized.theme ?? identityTheme;
		super({
			...(envelope?.fold ?? {}),
			...normalized,
			title: `edit ${normalized.path ?? data.path}`,
			lines: renderHunks(data.hunks, data.additions, data.removals, theme),
			...(defaultDisplayMode === undefined ? {} : { defaultDisplayMode }),
			...(currentDisplayMode === undefined ? {} : { currentDisplayMode }),
			...(manualOverride === undefined ? {} : { manualOverride }),
			colorSlot: normalized.colorSlot ?? envelope?.colorSlot ?? "accent_edit",
		});
		this.id = normalized.id;
	}

	setData(data: EditBlockData): void {
		this.setLines(renderHunks(data.hunks, data.additions, data.removals, this.theme));
	}
}

export const Edit = EditBlock;

function renderHunks(hunks: EditBlockData["hunks"], additions: number, removals: number, theme: SemanticTheme): string[] {
	return [`${theme.success(`+${additions}`)}/${theme.error(`-${removals}`)}`, ...hunks.flatMap((hunk) => [
		theme.muted(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
		...hunk.lines.map((line) => renderLine(line, theme)),
	])];
}

function renderLine(line: DiffLine, theme: SemanticTheme): string {
	const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
	const number = line.type === "add" ? line.newLine : line.type === "remove" ? line.oldLine : line.newLine ?? line.oldLine;
	const text = `${prefix}${number === undefined ? "" : `${number} `}${line.content}`;
	if (line.type === "add") return theme.success(text);
	if (line.type === "remove") return theme.error(text);
	return text;
}

function isEditData(value: EditBlockOptions | EditBlockData): value is EditBlockData {
	return "hunks" in value && "path" in value;
}

function unwrapData(value: EditBlockData | BlockEnvelope<"edit"> | undefined): EditBlockData | undefined {
	return value && "data" in value ? value.data : value;
}

function unwrapEnvelope(value: EditBlockData | BlockEnvelope<"edit"> | undefined): BlockEnvelope<"edit"> | undefined {
	return value && "kind" in value && value.kind === "edit" && "fold" in value ? value : undefined;
}
