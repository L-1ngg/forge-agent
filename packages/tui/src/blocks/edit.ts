import type { BlockEnvelope, DiffLine, EditBlockData } from "@myh/protocol";
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
		const data = unwrapData(normalized.data);
		if (!data) throw new Error("EditBlock requires diff hunk data");
		super({ ...normalized, title: `edit ${normalized.path ?? data.path}`, lines: renderHunks(data.hunks, data.additions, data.removals) });
		this.id = normalized.id;
	}

	setData(data: EditBlockData): void {
		this.setLines(renderHunks(data.hunks, data.additions, data.removals));
	}
}

export const Edit = EditBlock;

function renderHunks(hunks: EditBlockData["hunks"], additions: number, removals: number): string[] {
	return [`+${additions}/-${removals}`, ...hunks.flatMap((hunk) => [
		`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		...hunk.lines.map(renderLine),
	])];
}

function renderLine(line: DiffLine): string {
	const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
	const number = line.type === "add" ? line.newLine : line.type === "remove" ? line.oldLine : line.newLine ?? line.oldLine;
	return `${prefix}${number === undefined ? "" : `${number} `}${line.content}`;
}

function isEditData(value: EditBlockOptions | EditBlockData): value is EditBlockData {
	return "hunks" in value && "path" in value;
}

function unwrapData(value: EditBlockData | BlockEnvelope<"edit"> | undefined): EditBlockData | undefined {
	return value && "data" in value ? value.data : value;
}
