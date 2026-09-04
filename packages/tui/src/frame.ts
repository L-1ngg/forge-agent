import { graphemes, graphemeWidth } from "./width.ts";

/** Cell color: truecolor RGB, xterm-256 index, or the terminal default. */
export type TerminalColor = { kind: "default" } | { kind: "indexed"; index: number } | { kind: "rgb"; r: number; g: number; b: number };

export const DEFAULT_COLOR: TerminalColor = { kind: "default" };

export interface CellAttributes {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strikethrough: boolean;
}

export function defaultAttributes(): CellAttributes {
	return { bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false };
}

export interface CellStyle {
	foreground: TerminalColor;
	background: TerminalColor;
	attributes: CellAttributes;
}

export function defaultStyle(): CellStyle {
	return { foreground: DEFAULT_COLOR, background: DEFAULT_COLOR, attributes: defaultAttributes() };
}

export interface TerminalCell {
	grapheme: string;
	/** 0 marks a continuation cell covered by the wide grapheme to its left. */
	width: 0 | 1 | 2;
	foreground: TerminalColor;
	background: TerminalColor;
	attributes: CellAttributes;
}

export type CursorShape = "block" | "underline" | "bar";

export interface FrameCursor {
	x: number;
	y: number;
	visible: boolean;
	shape: CursorShape;
}

/** The single paint model (ADR-005): all visible output ends up in a frame. */
export interface TerminalFrame {
	columns: number;
	rows: number;
	cells: TerminalCell[][];
	cursor?: FrameCursor;
}

export function createFrame(columns: number, rows: number, style: CellStyle = defaultStyle()): TerminalFrame {
	const cells: TerminalCell[][] = [];
	for (let y = 0; y < rows; y++) {
		const row: TerminalCell[] = [];
		for (let x = 0; x < columns; x++) row.push(blankCell(style));
		cells.push(row);
	}
	return { columns, rows, cells };
}

export function blankCell(style: CellStyle = defaultStyle()): TerminalCell {
	return { grapheme: " ", width: 1, foreground: style.foreground, background: style.background, attributes: { ...style.attributes } };
}

export function cloneFrame(frame: TerminalFrame): TerminalFrame {
	return {
		columns: frame.columns,
		rows: frame.rows,
		cells: frame.cells.map((row) => row.map((cell) => ({ ...cell, foreground: { ...cell.foreground }, background: { ...cell.background }, attributes: { ...cell.attributes } }))),
		...(frame.cursor ? { cursor: { ...frame.cursor } } : {}),
	};
}

function blankAt(frame: TerminalFrame, x: number, y: number): void {
	const previous = frame.cells[y]?.[x];
	if (!previous) return;
	frame.cells[y]![x] = { grapheme: " ", width: 1, foreground: previous.foreground, background: previous.background, attributes: previous.attributes };
}

/**
 * Write one grapheme at (x, y); returns the next cursor column.
 * - Wide graphemes occupy (x) and a continuation cell at (x+1); clipped when they
 *   do not fit.
 * - Overwriting either half of a wide grapheme blanks the other half.
 * - Zero-width graphemes attach to the cell on the left; control chars drop.
 */
export function writeGrapheme(frame: TerminalFrame, x: number, y: number, grapheme: string, style: CellStyle = defaultStyle()): number {
	if (y < 0 || y >= frame.rows || x < 0 || x >= frame.columns) return x;
	const width = graphemeWidth(grapheme);
	if (width === 0) {
		if (/^[\p{Cc}]/u.test(grapheme)) return x;
		const left = frame.cells[y]?.[x - 1];
		if (left && left.width >= 1 && x - 1 >= 0) left.grapheme += grapheme;
		return x;
	}
	repairWideAt(frame, x, y);
	if (width === 2) {
		if (x + 1 >= frame.columns) return x; // clipped: a wide grapheme is never split
		repairWideAt(frame, x + 1, y);
		frame.cells[y]![x] = { grapheme, width: 2, foreground: style.foreground, background: style.background, attributes: { ...style.attributes } };
		frame.cells[y]![x + 1] = { grapheme: "", width: 0, foreground: style.foreground, background: style.background, attributes: { ...style.attributes } };
		return x + 2;
	}
	frame.cells[y]![x] = { grapheme, width: 1, foreground: style.foreground, background: style.background, attributes: { ...style.attributes } };
	return x + 1;
}

/** Writing onto part of a wide grapheme blanks its other half. */
function repairWideAt(frame: TerminalFrame, x: number, y: number): void {
	const cell = frame.cells[y]?.[x];
	if (!cell) return;
	if (cell.width === 0) blankAt(frame, x - 1, y);
	else if (cell.width === 2) blankAt(frame, x + 1, y);
}

/** Write text from (x, y), clipped at the frame's right edge; returns the end column. */
export function writeText(frame: TerminalFrame, x: number, y: number, text: string, style: CellStyle = defaultStyle()): number {
	let cursor = x;
	for (const grapheme of graphemes(text)) {
		if (cursor >= frame.columns) break;
		cursor = writeGrapheme(frame, cursor, y, grapheme, style);
	}
	return cursor;
}

/** Fill an inclusive rect with blank cells of the given style. */
export function fillRect(frame: TerminalFrame, x: number, y: number, columns: number, rows: number, style: CellStyle = defaultStyle()): void {
	for (let dy = 0; dy < rows; dy++) {
		for (let dx = 0; dx < columns; dx++) {
			const cx = x + dx;
			const cy = y + dy;
			if (cx < 0 || cy < 0 || cx >= frame.columns || cy >= frame.rows) continue;
			repairWideAt(frame, cx, cy);
			frame.cells[cy]![cx] = blankCell(style);
		}
	}
}

export function setCursor(frame: TerminalFrame, x: number, y: number, shape: CursorShape = "block"): void {
	frame.cursor = { x, y, visible: true, shape };
}

export function hideCursor(frame: TerminalFrame): void {
	frame.cursor = { x: 0, y: 0, visible: false, shape: "block" };
}

export interface FrameCellDiff {
	x: number;
	y: number;
	before: TerminalCell;
	after: TerminalCell;
}

export interface FrameDiff {
	equal: boolean;
	dimensionMismatch: boolean;
	cursorMismatch: boolean;
	differences: FrameCellDiff[];
}

function cellEquals(left: TerminalCell, right: TerminalCell): boolean {
	return (
		left.grapheme === right.grapheme &&
		left.width === right.width &&
		colorEquals(left.foreground, right.foreground) &&
		colorEquals(left.background, right.background) &&
		attributesEqual(left.attributes, right.attributes)
	);
}

export function colorEquals(left: TerminalColor, right: TerminalColor): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "indexed" && right.kind === "indexed") return left.index === right.index;
	if (left.kind === "rgb" && right.kind === "rgb") return left.r === right.r && left.g === right.g && left.b === right.b;
	return true;
}

export function attributesEqual(left: CellAttributes, right: CellAttributes): boolean {
	return (
		left.bold === right.bold &&
		left.dim === right.dim &&
		left.italic === right.italic &&
		left.underline === right.underline &&
		left.blink === right.blink &&
		left.inverse === right.inverse &&
		left.hidden === right.hidden &&
		left.strikethrough === right.strikethrough
	);
}

function cursorEquals(left: FrameCursor | undefined, right: FrameCursor | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.x === right.x && left.y === right.y && left.visible === right.visible && left.shape === right.shape;
}

/** Cell-by-cell diff; the primitive the host painter and the B6 parity gate share. */
export function diffFrames(before: TerminalFrame, after: TerminalFrame): FrameDiff {
	const dimensionMismatch = before.columns !== after.columns || before.rows !== after.rows;
	const differences: FrameCellDiff[] = [];
	if (!dimensionMismatch) {
		for (let y = 0; y < after.rows; y++) {
			for (let x = 0; x < after.columns; x++) {
				const beforeCell = before.cells[y]![x]!;
				const afterCell = after.cells[y]![x]!;
				if (!cellEquals(beforeCell, afterCell)) differences.push({ x, y, before: beforeCell, after: afterCell });
			}
		}
	}
	const cursorMismatch = !cursorEquals(before.cursor, after.cursor);
	return { equal: !dimensionMismatch && differences.length === 0 && !cursorMismatch, dimensionMismatch, cursorMismatch, differences };
}

/** Stable, machine-readable dump; the schema the B6 reference fixtures share. */
export interface FrameDumpCell {
	grapheme: string;
	width: 0 | 1 | 2;
	foreground: TerminalColor;
	background: TerminalColor;
	attributes: CellAttributes;
}

export interface FrameDump {
	columns: number;
	rows: number;
	cells: FrameDumpCell[][];
	cursor: FrameCursor | null;
}

export function dumpFrame(frame: TerminalFrame): FrameDump {
	return {
		columns: frame.columns,
		rows: frame.rows,
		cells: frame.cells.map((row) => row.map((cell) => ({ grapheme: cell.grapheme, width: cell.width, foreground: cell.foreground, background: cell.background, attributes: cell.attributes }))),
		cursor: frame.cursor ?? null,
	};
}

export function serializeFrame(frame: TerminalFrame): string {
	return JSON.stringify(dumpFrame(frame));
}

/** Plain-text view (graphemes only) for debugging and golden tests. */
export function frameToText(frame: TerminalFrame): string {
	return frame.cells.map((row) => row.map((cell) => (cell.width === 0 ? "" : cell.grapheme)).join("").trimEnd()).join("\n");
}
