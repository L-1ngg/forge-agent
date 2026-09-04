import { attributesEqual, colorEquals, diffFrames, type CellStyle, type TerminalCell, type TerminalColor, type TerminalFrame } from "./frame.ts";

/** Terminal control sequences owned by the host's paint path. */
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const LEAVE_ALT_SCREEN = "\x1b[?1049l";
export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";
export const RESET_ATTRIBUTES = "\x1b[0m";
export const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";

const CURSOR_SHAPE_CODES = { block: 2, underline: 4, bar: 6 } as const;

export function cursorPosition(x: number, y: number): string {
	return `\x1b[${y + 1};${x + 1}H`;
}

export function cursorShapeSequence(shape: "block" | "underline" | "bar"): string {
	return `\x1b[${CURSOR_SHAPE_CODES[shape]} q`;
}

function colorSgr(color: TerminalColor, target: "foreground" | "background"): string {
	if (color.kind === "default") return target === "foreground" ? "39" : "49";
	if (color.kind === "indexed") return `${target === "foreground" ? 38 : 48};5;${color.index}`;
	return `${target === "foreground" ? 38 : 48};2;${color.r};${color.g};${color.b}`;
}

/** Full SGR for a style after a reset; deterministic and easy to audit. */
export function styleToSgr(style: CellStyle): string {
	const parts: string[] = [RESET_ATTRIBUTES];
	const attributes: string[] = [];
	if (style.attributes.bold) attributes.push("1");
	if (style.attributes.dim) attributes.push("2");
	if (style.attributes.italic) attributes.push("3");
	if (style.attributes.underline) attributes.push("4");
	if (style.attributes.blink) attributes.push("5");
	if (style.attributes.inverse) attributes.push("7");
	if (style.attributes.hidden) attributes.push("8");
	if (style.attributes.strikethrough) attributes.push("9");
	const sgr = [...attributes, colorSgr(style.foreground, "foreground"), colorSgr(style.background, "background")];
	if (sgr.length > 0) parts.push(`\x1b[${sgr.join(";")}m`);
	return parts.join("");
}

export interface PaintOptions {
	/** Wrap the output in CSI ?2026 synchronized-update markers. */
	synchronized?: boolean;
}

/**
 * Render the diff between two frames as an ANSI byte stream. Only changed
 * cells are positioned and written; a null or size-mismatched `previous`
 * repaints everything. Contiguous changed columns share one cursor move.
 */
export function paintDiff(previous: TerminalFrame | null, next: TerminalFrame, options: PaintOptions = {}): string {
	const out: string[] = [];
	if (options.synchronized) out.push(SYNC_OUTPUT_BEGIN);
	let styled = false;

	const emitRun = (x: number, y: number, run: TerminalCell[]) => {
		if (run.length === 0) return;
		out.push(cursorPosition(x, y));
		let current: CellStyle | null = null;
		for (const cell of run) {
			if (cell.width === 0) continue;
			if (current === null || !styleEquals(current, cell)) {
				out.push(styleToSgr(cell));
				current = cell;
				styled = true;
			}
			out.push(cell.attributes.hidden ? " " : cell.grapheme);
		}
	};

	if (previous === null || previous.columns !== next.columns || previous.rows !== next.rows) {
		for (let y = 0; y < next.rows; y++) emitRun(0, y, next.cells[y]!);
	} else {
		const diff = diffFrames(previous, next);
		const rows = new Map<number, Set<number>>();
		for (const d of diff.differences) {
			let set = rows.get(d.y);
			if (!set) rows.set(d.y, (set = new Set()));
			// A continuation cell is never addressed alone: pull in its head.
			if (d.after.width === 0 && d.x > 0) set.add(d.x - 1);
			set.add(d.x);
			if (d.after.width === 2) set.add(d.x + 1);
		}
		for (const [y, columns] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
			const sorted = [...columns].filter((x) => x < next.columns).sort((a, b) => a - b);
			let index = 0;
			while (index < sorted.length) {
				const start = sorted[index]!;
				let end = start;
				while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
					index++;
					end = sorted[index]!;
				}
				emitRun(start, y, next.cells[y]!.slice(start, end + 1));
				index++;
			}
		}
	}

	if (next.cursor && next.cursor.visible) {
		out.push(cursorPosition(next.cursor.x, next.cursor.y));
		out.push(cursorShapeSequence(next.cursor.shape));
		out.push(SHOW_CURSOR);
	} else {
		out.push(HIDE_CURSOR);
	}
	if (styled) out.push(RESET_ATTRIBUTES);
	if (options.synchronized) out.push(SYNC_OUTPUT_END);
	return out.join("");
}

function styleEquals(style: CellStyle, cell: TerminalCell): boolean {
	return colorEquals(style.foreground, cell.foreground) && colorEquals(style.background, cell.background) && attributesEqual(style.attributes, cell.attributes);
}
