import { visibleWidth } from "@earendil-works/pi-tui";
import { nearestIndexed } from "./theme.ts";
import type { CellAttributes, TerminalCell, TerminalColor, TerminalFrame } from "./frame.ts";

/** One run from ptyctl's styled screen JSON artifact. */
export interface StyledJsonRun {
	text: string;
	fg?: string | null;
	bg?: string | null;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	blink?: boolean;
	inverse?: boolean;
	hidden?: boolean;
	/** ptyctl calls this modifier `strikeout`; accept the long spelling too. */
	strikeout?: boolean;
	strikethrough?: boolean;
}

/** One 1-based line from a ptyctl styled JSON capture. */
export interface StyledJsonLine {
	line: number;
	runs: readonly StyledJsonRun[];
}

export type StyledJsonColorMode = "resolved" | "indexed" | "ansi256";

export interface StyledJsonFrameOptions {
	/** Defaults to the widest row in the document. */
	columns?: number;
	/** Defaults to the number of source rows. */
	rows?: number;
	/** `resolved` keeps RGB; `indexed`/`ansi256` models xterm 256 quantization. */
	colorMode?: StyledJsonColorMode;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DEFAULT_COLOR: TerminalColor = { kind: "default" };
const DEFAULT_ATTRIBUTES: CellAttributes = {
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	blink: false,
	inverse: false,
	hidden: false,
	strikethrough: false,
};

/** Parse and validate a ptyctl styled JSON payload. */
export function parseStyledJson(source: string | unknown): StyledJsonLine[] {
	let value: unknown = source;
	if (typeof source === "string") {
		try {
			value = JSON.parse(source);
		} catch (error) {
			throw new Error(`invalid styled JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!Array.isArray(value)) throw new Error("styled JSON must be an array of lines");
	const lines = value.map((line, index) => parseLine(line, index));
	for (let index = 0; index < lines.length; index++) {
		if (lines[index]?.line !== index + 1) throw new Error("styled JSON line numbers must be contiguous and 1-based");
	}
	return lines;
}

/** Convert a styled capture to a frame with RGB colors as they appear in the artifact. */
export function styledJsonToResolvedFrame(source: string | unknown, options: StyledJsonFrameOptions = {}): TerminalFrame {
	return styledJsonToFrame(source, { ...options, colorMode: "resolved" });
}

/** Convert a styled capture to the xterm 256-color cell representation. */
export function styledJsonToIndexedFrame(source: string | unknown, options: StyledJsonFrameOptions = {}): TerminalFrame {
	return styledJsonToFrame(source, { ...options, colorMode: "indexed" });
}

/** Generic converter; the default is the resolved RGB representation. */
export function styledJsonToFrame(source: string | unknown, options: StyledJsonFrameOptions = {}): TerminalFrame {
	const lines = parseStyledJson(source);
	const columns = options.columns === undefined ? widestLine(lines) : positiveDimension(options.columns, "columns");
	const rows = options.rows === undefined ? Math.max(1, lines.length) : positiveDimension(options.rows, "rows");
	if (lines.length > rows) throw new Error(`styled JSON has ${lines.length} rows but viewport has ${rows}`);
	const mode = options.colorMode ?? "resolved";
	const cells = Array.from({ length: rows }, () => Array.from({ length: columns }, () => emptyCell()));
	for (let rowIndex = 0; rowIndex < lines.length; rowIndex++) {
		const line = lines[rowIndex]!;
		paintLine(line, cells[rowIndex]!, columns, mode);
	}
	return { columns, rows, cells };
}

/** Alias used by callers that treat the styled artifact as the reference frame. */
export const frameFromStyledJson = styledJsonToResolvedFrame;

function parseLine(value: unknown, index: number): StyledJsonLine {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`styled JSON line ${index + 1} must be an object`);
	const record = value as Record<string, unknown>;
	if (!Number.isInteger(record.line) || (record.line as number) < 1) throw new Error(`styled JSON line ${index + 1} has an invalid line number`);
	if (!Array.isArray(record.runs)) throw new Error(`styled JSON line ${index + 1} runs must be an array`);
	return {
		line: record.line as number,
		runs: record.runs.map((run, runIndex) => parseRun(run, index, runIndex)),
	};
}

function parseRun(value: unknown, lineIndex: number, runIndex: number): StyledJsonRun {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`styled JSON line ${lineIndex + 1} run ${runIndex + 1} must be an object`);
	const record = value as Record<string, unknown>;
	if (typeof record.text !== "string") throw new Error(`styled JSON line ${lineIndex + 1} run ${runIndex + 1} text must be a string`);
	if (record.text.includes("\n") || record.text.includes("\r")) throw new Error(`styled JSON line ${lineIndex + 1} contains a newline inside a run`);
	for (const key of ["fg", "bg"] as const) {
		const color = record[key];
		if (color !== undefined && color !== null && typeof color !== "string") throw new Error(`styled JSON line ${lineIndex + 1} run ${runIndex + 1} ${key} must be a hex string`);
	}
	return {
		text: record.text,
		...(record.fg === undefined ? {} : { fg: record.fg as string | null }),
		...(record.bg === undefined ? {} : { bg: record.bg as string | null }),
		...booleanField(record, "bold"),
		...booleanField(record, "dim"),
		...booleanField(record, "italic"),
		...booleanField(record, "underline"),
		...booleanField(record, "blink"),
		...booleanField(record, "inverse"),
		...booleanField(record, "hidden"),
		...booleanField(record, "strikeout"),
		...booleanField(record, "strikethrough"),
	};
}

function booleanField(record: Record<string, unknown>, key: string): Partial<StyledJsonRun> {
	if (record[key] === undefined) return {};
	if (typeof record[key] !== "boolean") throw new Error(`styled JSON modifier ${key} must be boolean`);
	return { [key]: record[key] } as Partial<StyledJsonRun>;
}

function widestLine(lines: readonly StyledJsonLine[]): number {
	const width = Math.max(1, ...lines.map((line) => line.runs.reduce((sum, run) => sum + visibleWidth(run.text), 0)));
	return width;
}

function paintLine(line: StyledJsonLine, cells: TerminalCell[], columns: number, mode: StyledJsonColorMode): void {
	let column = 0;
	let lastStyle = defaultStyle();
	for (const run of line.runs) {
		const style = styleForRun(run, mode);
		lastStyle = style;
		for (const { segment } of SEGMENTER.segment(run.text)) {
			const width = Math.min(2, visibleWidth(segment)) as 0 | 1 | 2;
			if (width === 0) {
				if (column === 0) throw new Error(`styled JSON line ${line.line} begins with a combining grapheme`);
				const previous = cells[column - 1];
				if (previous) previous.grapheme += segment;
				continue;
			}
			if (column + width > columns) throw new Error(`styled JSON line ${line.line} exceeds viewport width`);
			cells[column] = styledCell(segment, width, style);
			if (width === 2) cells[column + 1] = styledCell("", 0, style);
			column += width;
		}
	}
	// Styled captures normally contain an explicit background run for every
	// cell. When a fixture is shorter, keep the final run's style on the
	// trailing blanks so a cropped canvas does not lose its background.
	while (column < columns) {
		cells[column] = styledCell(" ", 1, lastStyle);
		column++;
	}
}

function styleForRun(run: StyledJsonRun, mode: StyledJsonColorMode): { foreground: TerminalColor; background: TerminalColor; attributes: CellAttributes } {
	return {
		foreground: parseColor(run.fg, mode),
		background: parseColor(run.bg, mode),
		attributes: {
			bold: run.bold === true,
			dim: run.dim === true,
			italic: run.italic === true,
			underline: run.underline === true,
			blink: run.blink === true,
			inverse: run.inverse === true,
			hidden: run.hidden === true,
			strikethrough: run.strikeout === true || run.strikethrough === true,
		},
	};
}

function parseColor(value: string | null | undefined, mode: StyledJsonColorMode): TerminalColor {
	if (value === undefined || value === null || value.trim() === "") return { ...DEFAULT_COLOR };
	const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
	if (!match) throw new Error(`invalid styled JSON color: ${value}`);
	const hex = match[1]!.length === 3 ? match[1]!.split("").map((part) => `${part}${part}`).join("") : match[1]!;
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return mode === "resolved" ? { kind: "rgb", r, g, b } : { kind: "indexed", index: nearestIndexed(r, g, b) };
}

function defaultStyle(): { foreground: TerminalColor; background: TerminalColor; attributes: CellAttributes } {
	return { foreground: { ...DEFAULT_COLOR }, background: { ...DEFAULT_COLOR }, attributes: { ...DEFAULT_ATTRIBUTES } };
}

function emptyCell(): TerminalCell {
	return { grapheme: " ", width: 1, foreground: { ...DEFAULT_COLOR }, background: { ...DEFAULT_COLOR }, attributes: { ...DEFAULT_ATTRIBUTES } };
}

function styledCell(grapheme: string, width: 0 | 1 | 2, style: { foreground: TerminalColor; background: TerminalColor; attributes: CellAttributes }): TerminalCell {
	return {
		grapheme,
		width,
		foreground: { ...style.foreground },
		background: { ...style.background },
		attributes: { ...style.attributes },
	};
}

function positiveDimension(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
	return value;
}
