import type { BlockEnvelope, DiffLine, EditBlockData } from "@myh/protocol";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { identityTheme, type SemanticTheme } from "../theme.ts";
import { FoldBlock, type FoldBlockOptions } from "./fold.ts";
import type { EntryRow } from "../transcript/types.ts";

export interface EditBlockOptions extends Omit<FoldBlockOptions, "title" | "lines"> {
	id?: string;
	path?: string;
	data?: EditBlockData | BlockEnvelope<"edit">;
}

/** Renders already-computed hunks; no diff algorithm belongs in this package. */
export class EditBlock extends FoldBlock {
	readonly id: string | undefined;
	private pathText: string;
	private hunksData: EditBlockData["hunks"];
	private additionsCount: number;
	private removalsCount: number;

	constructor(options: EditBlockOptions | EditBlockData) {
		// A raw EditBlockData can also carry local fold options in tests and
		// headless callers; preserve those fields while unwrapping its payload.
		const normalized = isEditData(options) ? { ...options, data: options } : options;
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
			title: `Edit ${normalized.path ?? data.path}`,
			lines: renderHunks(data.hunks, data.additions, data.removals, theme),
			...(defaultDisplayMode === undefined ? {} : { defaultDisplayMode }),
			...(currentDisplayMode === undefined ? {} : { currentDisplayMode }),
			...(manualOverride === undefined ? {} : { manualOverride }),
			colorSlot: normalized.colorSlot ?? envelope?.colorSlot ?? "accent_edit",
		});
		this.id = normalized.id;
		this.pathText = normalized.path ?? data.path;
		this.hunksData = data.hunks;
		this.additionsCount = data.additions;
		this.removalsCount = data.removals;
	}

	setData(data: EditBlockData): void {
		this.pathText = data.path;
		this.hunksData = data.hunks;
		this.additionsCount = data.additions;
		this.removalsCount = data.removals;
		this.setTitle(`Edit ${data.path}`);
		this.setLines(renderHunks(data.hunks, data.additions, data.removals, this.theme));
	}

	/** Structured Grok-style rows: header, separator, then typed diff bands. */
	renderEntryRows(width: number): readonly EntryRow[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (this.fold.displayMode === "collapsed") {
			const summary = this.additionsCount > 0 || this.removalsCount > 0
				? ` +${this.additionsCount}/-${this.removalsCount}`
				: "";
			const contentWidth = Math.max(1, safeWidth - 2);
			const pathWidth = Math.max(0, contentWidth - visibleWidth("Edit ") - visibleWidth(summary));
			const path = truncateToWidth(basename(this.pathText), pathWidth, "…", false);
			const header = `${this.theme.strong(this.theme.muted("Edit "))}${this.theme.muted(path)}`;
			const suffix = summary
				? ` ${this.theme.success(`+${this.additionsCount}`)}/${this.theme.error(`-${this.removalsCount}`)}`
				: "";
			return [{ text: `${header}${suffix}` }];
		}

		const rows: EntryRow[] = [];
		rows.push(...wrapEditHeader(this.pathText, safeWidth, this.theme));
		const nonEmptyHunks = this.hunksData.filter((hunk) => hunk.lines.length > 0);
		if (nonEmptyHunks.length > 0) {
			rows.push({ text: "" });
			for (const [index, hunk] of nonEmptyHunks.entries()) {
				if (index > 0) rows.push({ text: this.theme.muted(`  ${hunkSeparator(nonEmptyHunks[index - 1]!, hunk)}`) });
				rows.push(...renderHunkRows(hunk, safeWidth, this.theme));
			}
		}
		return rows;
	}
}

export const Edit = EditBlock;

function renderHunks(hunks: EditBlockData["hunks"], additions: number, removals: number, theme: SemanticTheme): string[] {
	return [
		`${theme.success(`+${additions}`)}/${theme.error(`-${removals}`)}`,
		...hunks.filter((hunk) => hunk.lines.length > 0).flatMap((hunk, index, visibleHunks) => [
			...(index === 0 ? [] : [theme.muted(`  ${hunkSeparator(visibleHunks[index - 1]!, hunk)}`)]),
			...renderHunkRows(hunk, 120, theme).map((row) => row.text),
		]),
	];
}

function renderHunkRows(hunk: EditBlockData["hunks"][number], width: number, theme: SemanticTheme): EntryRow[] {
	const numberWidth = hunkNumberWidth(hunk);
	const gutterWidth = 2 + numberWidth + 2;
	const contentWidth = Math.max(1, width - gutterWidth);
	const rows: EntryRow[] = [];
	for (const line of hunk.lines) {
		const number = lineNumber(line, hunk);
		const content = expandTabs(line.content);
		const wrapped = wrapTextWithAnsi(content, contentWidth);
		const segments = wrapped.length > 0 ? wrapped : [""];
		for (const [index, segment] of segments.entries()) {
			const gutter = index === 0
				? `${"  "}${String(number ?? "").padStart(numberWidth, " ")}${"  "}`
				: " ".repeat(gutterWidth);
			const gutterTone = line.type === "add" ? theme.success : line.type === "remove" ? theme.error : theme.muted;
			const contentTone = line.type === "context" ? theme.muted : theme.status;
			const text = `${gutterTone(gutter)}${contentTone(segment)}`;
			const background = line.type === "add" ? "diff_add" : line.type === "remove" ? "diff_remove" : undefined;
			rows.push(background === undefined ? { text } : { text, background, backgroundStart: gutterWidth });
		}
	}
	return rows;
}

function hunkNumberWidth(hunk: EditBlockData["hunks"][number]): number {
	return Math.max(1, ...hunk.lines.map((line) => String(lineNumber(line, hunk) ?? "").length));
}

function hunkSeparator(previous: EditBlockData["hunks"][number], next: EditBlockData["hunks"][number]): string {
	const previousLast = previous.lines
		.slice()
		.reverse()
		.find((line) => line.type !== "remove" && line.newLine !== undefined)?.newLine;
	const nextFirst = next.lines.find((line) => line.type !== "remove" && line.newLine !== undefined)?.newLine;
	if (previousLast === undefined || nextFirst === undefined) return "…";
	const gap = nextFirst - previousLast - 1;
	return gap > 0 ? `… ${gap} unchanged ${gap === 1 ? "line" : "lines"}` : "…";
}

function lineNumber(line: DiffLine, hunk: EditBlockData["hunks"][number]): number | undefined {
	return line.type === "remove" ? line.oldLine ?? hunk.oldStart : line.newLine ?? line.oldLine ?? hunk.newStart;
}

function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/u, "");
	const value = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
	return value || path;
}

function expandTabs(value: string): string {
	return value.replaceAll("\t", "    ");
}

function wrapEditHeader(path: string, width: number, theme: SemanticTheme): EntryRow[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const hangWidth = visibleWidth("       ");
	const pathWidth = Math.max(1, safeWidth - hangWidth);
	const wrapped = wrapTextWithAnsi(theme.path(path), pathWidth);
	const rows = wrapped.length > 0 ? wrapped : [""];
	return rows.map((segment, index) => ({
		text: index === 0 ? `${theme.strong(theme.status("Edit "))}${segment}` : `${" ".repeat(hangWidth)}${segment}`,
	}));
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
