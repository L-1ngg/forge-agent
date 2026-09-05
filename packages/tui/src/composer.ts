import { writeText, setCursor, type CellStyle, type TerminalFrame } from "./frame.ts";
import { graphemes, graphemeWidth, truncateToWidth, visibleWidth } from "./width.ts";
import type { EditorState } from "./editor.ts";
import type { Theme } from "./theme.ts";

/**
 * Composer chrome aligned with grok's PromptWidget geometry: rounded border,
 * `❯` prefix, wrapped draft, bottom-border model caption (phase 2.2 B2).
 * Exact reference values get locked by the B6 parity gate.
 */
export interface ComposerPaintInput {
	frame: TerminalFrame;
	x: number;
	y: number;
	width: number;
	height: number;
	draft: EditorState;
	theme: Theme;
	/** Model caption on the bottom border; omitted when unknown. */
	caption?: string | undefined;
	placeholder?: string | undefined;
	compact: boolean;
}

interface VisualLine {
	graphemes: string[];
	logicalLine: number;
	/** Grapheme index within the logical line where this visual row starts. */
	startColumn: number;
}

/** Wrap logical draft lines to the content width, keeping graphemes whole. */
export function wrapDraft(draft: EditorState, contentWidth: number): { lines: VisualLine[]; cursorX: number; cursorY: number } {
	const lines: VisualLine[] = [];
	let cursorX = 0;
	let cursorY = 0;
	for (let logical = 0; logical < draft.lines.length; logical++) {
		const glyphs = graphemes(draft.lines[logical]!);
		if (glyphs.length === 0) {
			lines.push({ graphemes: [], logicalLine: logical, startColumn: 0 });
			if (draft.cursorLine === logical) {
				cursorY = lines.length - 1;
				cursorX = 0;
			}
			continue;
		}
		let start = 0;
		while (start < glyphs.length) {
			let width = 0;
			let end = start;
			while (end < glyphs.length) {
				const w = graphemeWidth(glyphs[end]!);
				if (w > 0 && width + w > contentWidth) break;
				width += w;
				end++;
			}
			if (end === start) end++; // a lone zero-width grapheme still advances
			lines.push({ graphemes: glyphs.slice(start, end), logicalLine: logical, startColumn: start });
			if (draft.cursorLine === logical && draft.cursorColumn >= start && (draft.cursorColumn < end || end === glyphs.length)) {
				cursorY = lines.length - 1;
				cursorX = 0;
				for (let index = start; index < draft.cursorColumn; index++) cursorX += graphemeWidth(glyphs[index]!);
			}
			start = end;
		}
	}
	// A cursor sitting exactly on a wrap boundary at end-of-text belongs to a
	// phantom next row, not past the right edge of the current one.
	if (cursorX === contentWidth && draft.cursorLine === draft.lines.length - 1) {
		cursorY += 1;
		cursorX = 0;
	}
	return { lines, cursorX, cursorY };
}

const PROMPT_PREFIX = "❯ ";
const INNER_PADDING = 1; // spaces between border and content on each side

export function paintComposer(input: ComposerPaintInput): void {
	const { frame, x, y, width, height, draft, theme } = input;
	if (width < 4 || height < 3) return;
	const borderColor = theme.color("prompt_border_active");
	const border: CellStyle = { foreground: borderColor, background: { kind: "default" }, attributes: { bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false } };
	const text: CellStyle = { ...border, foreground: theme.color("status") };
	const muted: CellStyle = { ...border, foreground: theme.color("muted") };

	const right = x + width - 1;
	writeText(frame, x, y, `╭${"─".repeat(width - 2)}╮`, border);
	for (let row = 1; row < height - 1; row++) {
		writeText(frame, x, y + row, "│", border);
		writeText(frame, right, y + row, "│", border);
	}
	const caption = input.caption ?? "";
	const captionText = caption ? ` ${truncateToWidth(caption, Math.max(0, width - 4))} ` : "";
	const captionWidth = visibleWidth(captionText);
	const dashCount = Math.max(0, width - 2 - captionWidth);
	writeText(frame, x, y + height - 1, `╰${"─".repeat(dashCount)}`, border);
	if (captionText) writeText(frame, x + 1 + dashCount, y + height - 1, captionText, muted);
	writeText(frame, right, y + height - 1, "╯", border);

	const contentX = x + 1 + INNER_PADDING;
	const contentWidth = width - 2 - INNER_PADDING * 2;
	const contentRows = height - 2;
	const wrapWidth = Math.max(1, contentWidth - graphemeWidth(PROMPT_PREFIX.trimEnd()) - 1);
	const wrapped = wrapDraft(draft, wrapWidth);
	// Only the first visual row carries the prompt prefix; continuation rows indent.
	const indent = graphemeWidth(PROMPT_PREFIX.trimEnd()) + 1;
	const empty = draft.lines.length === 1 && draft.lines[0] === "";
	const skip = Math.max(0, wrapped.cursorY - (contentRows - 1));
	for (let row = 0; row < contentRows; row++) {
		const visual = wrapped.lines[row + skip];
		const lineY = y + 1 + row;
		if (row === 0 && skip === 0) writeText(frame, contentX, lineY, PROMPT_PREFIX, muted);
		if (!visual) break;
		if (empty && row === 0 && input.placeholder) {
			writeText(frame, contentX + indent, lineY, truncateToWidth(input.placeholder, wrapWidth), muted);
			continue;
		}
		writeText(frame, contentX + indent, lineY, visual.graphemes.join(""), text);
	}
	setCursor(frame, contentX + indent + wrapped.cursorX, y + 1 + wrapped.cursorY - skip, "block");
}
