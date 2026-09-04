import { inflateSync } from "node:zlib";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type TerminalColor =
	| { kind: "default" }
	| { kind: "indexed"; index: number }
	| { kind: "rgb"; r: number; g: number; b: number };

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

export interface TerminalCell {
	grapheme: string;
	width: 0 | 1 | 2;
	foreground: TerminalColor;
	background: TerminalColor;
	attributes: CellAttributes;
}

export interface TerminalFrame {
	columns: number;
	rows: number;
	cells: TerminalCell[][];
	cursor?: { x: number; y: number; visible: boolean; shape: "block" | "underline" | "bar" };
}

export interface FrameCellDiff {
	x: number;
	y: number;
	expected: TerminalCell;
	actual: TerminalCell;
}

export interface FrameDiff {
	equal: boolean;
	differingCells: number;
	dimensionMismatch: boolean;
	cursorMismatch: boolean;
	differences: FrameCellDiff[];
}

export interface ReferenceEnvironmentManifest {
	status: "locked" | "unlocked";
	terminal: { name: string; version: string; renderer: string };
	os: { name: string; version: string; displayServer: string };
	font: { path: string; sha256: string; family: string; size: number; lineHeight: number; weight: number; hinting: string; antialiasing: string };
	display: { dpi: number; scale: number; contentWidthPx: number; contentHeightPx: number; cellWidthPx: number; cellHeightPx: number; colorProfile: string };
	terminalTheme: { name: string; defaultForeground: string; defaultBackground: string; ansi16Sha256: string; ansi256Sha256: string; truecolor: boolean };
	viewport: { columns: number; rows: number };
	runtime: { term: string; colorTerm: string; locale: string; unicodeWidthPolicy: string; timezone: string };
	cursor: { visible: boolean; shape: "block" | "underline" | "bar"; blink: boolean; phase: number };
	determinism: { clock: string; animationFrame: number; randomSeed: number; fixture: string };
}

export type ArtifactKind = "reference" | "candidate";

export interface ArtifactManifest {
	kind: ArtifactKind;
	scenario: string;
	upstreamCommit: string;
	sourceRevision: string;
	environmentStatus: ReferenceEnvironmentManifest["status"];
	parityStatus: "eligible" | "diagnostic";
	environmentSha256: string;
	columns: number;
	rows: number;
	artifacts: {
		fixtureSha256: string;
		terminalStreamSha256: string;
		ansiFrameSha256: string;
		cellFrameSha256: string;
		pngSha256: string;
	};
}

export type ManifestComparison =
	| { status: "match" }
	| { status: "environment-mismatch"; fields: string[] };

export interface RgbaImage {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export interface RgbaDiff {
	equal: boolean;
	dimensionMismatch: boolean;
	differingPixels: number;
	maxChannelDelta: number;
}

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
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const CSI_PATTERN = /^\u001b\[([0-9;:?]*)([ -/]*)([@-~])/;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface PaintStyle {
	foreground: TerminalColor;
	background: TerminalColor;
	attributes: CellAttributes;
}

export function frameFromLines(lines: readonly string[], columns: number, rows = lines.length): TerminalFrame {
	const safeColumns = normalizeDimension(columns, "columns");
	const safeRows = normalizeDimension(rows, "rows");
	const cells = Array.from({ length: safeRows }, () => Array.from({ length: safeColumns }, () => emptyCell()));
	for (let y = 0; y < Math.min(lines.length, safeRows); y++) paintAnsiLine(lines[y] ?? "", cells[y] ?? []);
	const cursor = cursorFromLines(lines, safeColumns, safeRows);
	return cursor === undefined ? { columns: safeColumns, rows: safeRows, cells } : { columns: safeColumns, rows: safeRows, cells, cursor };
}

/** Capture the rendered document and logical cursor from a real TUI host. */
export function captureTuiFrame(tui: TUI, width = tui.terminal.columns): { ansi: string; frame: TerminalFrame } {
	const columns = normalizeDimension(width, "width");
	const rows = normalizeDimension(tui.terminal.rows, "rows");
	const ansi = tui.render(columns).slice(0, rows).join("\n");
	return { ansi, frame: frameFromLines(ansi.split("\n"), columns, rows) };
}

export function diffFrames(expected: TerminalFrame, actual: TerminalFrame, maxReportedDifferences = 32): FrameDiff {
	const differences: FrameCellDiff[] = [];
	let differingCells = 0;
	const rows = Math.max(expected.rows, actual.rows);
	const columns = Math.max(expected.columns, actual.columns);
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < columns; x++) {
			const expectedCell = expected.cells[y]?.[x] ?? emptyCell();
			const actualCell = actual.cells[y]?.[x] ?? emptyCell();
			if (sameCell(expectedCell, actualCell)) continue;
			differingCells++;
			if (differences.length < Math.max(0, Math.floor(maxReportedDifferences))) differences.push({ x, y, expected: cloneCell(expectedCell), actual: cloneCell(actualCell) });
		}
	}
	const dimensionMismatch = expected.columns !== actual.columns || expected.rows !== actual.rows;
	const cursorMismatch = !sameCursor(expected.cursor, actual.cursor);
	return { equal: !dimensionMismatch && differingCells === 0 && !cursorMismatch, differingCells, dimensionMismatch, cursorMismatch, differences };
}

export function compareEnvironmentManifests(expected: ReferenceEnvironmentManifest, actual: ReferenceEnvironmentManifest): ManifestComparison {
	const fields: string[] = [];
	compareManifestValue(expected, actual, "", fields);
	return fields.length === 0 ? { status: "match" } : { status: "environment-mismatch", fields };
}

export function diffRgba(expected: RgbaImage, actual: RgbaImage): RgbaDiff {
	const dimensionMismatch = expected.width !== actual.width || expected.height !== actual.height;
	const pixels = Math.max(expected.width * expected.height, actual.width * actual.height);
	let differingPixels = 0;
	let maxChannelDelta = 0;
	for (let pixel = 0; pixel < pixels; pixel++) {
		let differs = false;
		for (let channel = 0; channel < 4; channel++) {
			const offset = pixel * 4 + channel;
			const expectedValue = expected.pixels[offset] ?? -1;
			const actualValue = actual.pixels[offset] ?? -1;
			const delta = expectedValue < 0 || actualValue < 0 ? 255 : Math.abs(expectedValue - actualValue);
			if (delta > 0) differs = true;
			maxChannelDelta = Math.max(maxChannelDelta, delta);
		}
		if (differs) differingPixels++;
	}
	return { equal: !dimensionMismatch && differingPixels === 0, dimensionMismatch, differingPixels, maxChannelDelta };
}

/** Decode non-interlaced 8-bit RGB/RGBA PNGs into the exact comparison format. */
export function decodePngRgba(bytes: Uint8Array): RgbaImage {
	assertPngSignature(bytes);
	let offset = PNG_SIGNATURE.length;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let bitDepth = -1;
	let interlace = -1;
	const idat: Uint8Array[] = [];
	while (offset + 12 <= bytes.length) {
		const length = readUint32(bytes, offset);
		const type = ascii(bytes.subarray(offset + 4, offset + 8));
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > bytes.length) throw new Error("truncated PNG chunk");
		const data = bytes.subarray(dataStart, dataEnd);
		if (type === "IHDR") {
			if (data.length !== 13) throw new Error("invalid PNG IHDR");
			width = readUint32(data, 0);
			height = readUint32(data, 4);
			bitDepth = data[8] ?? -1;
			colorType = data[9] ?? -1;
			interlace = data[12] ?? -1;
		} else if (type === "IDAT") idat.push(data.slice());
		else if (type === "IEND") break;
		offset = dataEnd + 4;
	}
	if (width < 1 || height < 1) throw new Error("PNG is missing dimensions");
	if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error("only non-interlaced 8-bit RGB/RGBA PNGs are supported");
	const channels = colorType === 6 ? 4 : 3;
	const stride = width * channels;
	const inflated = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
	if (inflated.length !== (stride + 1) * height) throw new Error("invalid PNG scanline length");
	const reconstructed = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const sourceOffset = y * (stride + 1);
		const filter = inflated[sourceOffset] ?? -1;
		for (let x = 0; x < stride; x++) {
			const raw = inflated[sourceOffset + 1 + x] ?? 0;
			const target = y * stride + x;
			const left = x >= channels ? reconstructed[target - channels] ?? 0 : 0;
			const up = y > 0 ? reconstructed[target - stride] ?? 0 : 0;
			const upLeft = y > 0 && x >= channels ? reconstructed[target - stride - channels] ?? 0 : 0;
			reconstructed[target] = unfilterByte(filter, raw, left, up, upLeft);
		}
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const source = pixel * channels;
		const target = pixel * 4;
		pixels[target] = reconstructed[source] ?? 0;
		pixels[target + 1] = reconstructed[source + 1] ?? 0;
		pixels[target + 2] = reconstructed[source + 2] ?? 0;
		pixels[target + 3] = colorType === 6 ? reconstructed[source + 3] ?? 0 : 255;
	}
	return { width, height, pixels };
}

function paintAnsiLine(line: string, cells: TerminalCell[]): void {
	let style = defaultStyle();
	let column = 0;
	let plain = "";
	const flush = (): void => {
		if (!plain) return;
		for (const { segment } of GRAPHEME_SEGMENTER.segment(plain)) {
			if (segment === "\r") {
				column = 0;
				continue;
			}
			if (segment === "\n") break;
			const width = Math.min(2, visibleWidth(segment)) as 0 | 1 | 2;
			if (width === 0) {
				const previous = column > 0 ? cells[column - 1] : undefined;
				if (previous) previous.grapheme += segment;
				continue;
			}
			if (column + width > cells.length) break;
			cells[column] = styledCell(segment, width, style);
			if (width === 2) cells[column + 1] = styledCell("", 0, style);
			column += width;
		}
		plain = "";
	};

	for (let index = 0; index < line.length;) {
		if (line[index] !== "\u001b") {
			plain += line[index] ?? "";
			index++;
			continue;
		}
		flush();
		const match = line.slice(index).match(CSI_PATTERN);
		if (match) {
			if (match[3] === "m") style = applySgr(style, match[1] ?? "");
			index += match[0].length;
			continue;
		}
		const stringEnd = findEscapeStringEnd(line, index);
		index = stringEnd > index ? stringEnd : index + 1;
	}
	flush();
}

function cursorFromLines(lines: readonly string[], columns: number, rows: number): NonNullable<TerminalFrame["cursor"]> | undefined {
	for (let y = 0; y < Math.min(rows, lines.length); y++) {
		const line = lines[y] ?? "";
		const marker = line.indexOf(CURSOR_MARKER);
		if (marker < 0) continue;
		const x = Math.min(columns, visibleWidth(stripTerminalSequences(line.slice(0, marker))));
		return { x, y, visible: true, shape: "block" };
	}
	return undefined;
}

function applySgr(current: PaintStyle, source: string): PaintStyle {
	const parameters = source === "" ? [0] : source.replaceAll(":", ";").split(";").map((value) => value === "" ? 0 : Number(value));
	let style = cloneStyle(current);
	for (let index = 0; index < parameters.length; index++) {
		const code = parameters[index] ?? 0;
		if (code === 0) style = defaultStyle();
		else if (code === 1) style.attributes.bold = true;
		else if (code === 2) style.attributes.dim = true;
		else if (code === 3) style.attributes.italic = true;
		else if (code === 4 || code === 21) style.attributes.underline = true;
		else if (code === 5 || code === 6) style.attributes.blink = true;
		else if (code === 7) style.attributes.inverse = true;
		else if (code === 8) style.attributes.hidden = true;
		else if (code === 9) style.attributes.strikethrough = true;
		else if (code === 22) { style.attributes.bold = false; style.attributes.dim = false; }
		else if (code === 23) style.attributes.italic = false;
		else if (code === 24) style.attributes.underline = false;
		else if (code === 25) style.attributes.blink = false;
		else if (code === 27) style.attributes.inverse = false;
		else if (code === 28) style.attributes.hidden = false;
		else if (code === 29) style.attributes.strikethrough = false;
		else if (code >= 30 && code <= 37) style.foreground = { kind: "indexed", index: code - 30 };
		else if (code >= 40 && code <= 47) style.background = { kind: "indexed", index: code - 40 };
		else if (code >= 90 && code <= 97) style.foreground = { kind: "indexed", index: code - 90 + 8 };
		else if (code >= 100 && code <= 107) style.background = { kind: "indexed", index: code - 100 + 8 };
		else if (code === 39) style.foreground = DEFAULT_COLOR;
		else if (code === 49) style.background = DEFAULT_COLOR;
		else if (code === 38 || code === 48) {
			const parsed = parseExtendedColor(parameters, index);
			if (parsed) {
				if (code === 38) style.foreground = parsed.color;
				else style.background = parsed.color;
				index += parsed.consumed;
			}
		}
	}
	return style;
}

function parseExtendedColor(parameters: number[], index: number): { color: TerminalColor; consumed: number } | undefined {
	const mode = parameters[index + 1];
	if (mode === 5) {
		const value = parameters[index + 2];
		return value !== undefined && value >= 0 && value <= 255 ? { color: { kind: "indexed", index: value }, consumed: 2 } : undefined;
	}
	if (mode === 2) {
		const r = parameters[index + 2];
		const g = parameters[index + 3];
		const b = parameters[index + 4];
		return [r, g, b].every((value) => value !== undefined && value >= 0 && value <= 255)
			? { color: { kind: "rgb", r: r as number, g: g as number, b: b as number }, consumed: 4 }
			: undefined;
	}
	return undefined;
}

function findEscapeStringEnd(line: string, start: number): number {
	if (line[start + 1] !== "]" && line[start + 1] !== "P" && line[start + 1] !== "_") return start;
	for (let index = start + 2; index < line.length; index++) {
		if (line[index] === "\u0007") return index + 1;
		if (line[index] === "\u001b" && line[index + 1] === "\\") return index + 2;
	}
	return line.length;
}

function compareManifestValue(expected: unknown, actual: unknown, path: string, fields: string[]): void {
	if (Object.is(expected, actual)) return;
	if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null || Array.isArray(expected) || Array.isArray(actual)) {
		fields.push(path || "$");
		return;
	}
	const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
	for (const key of [...keys].sort()) compareManifestValue((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], path ? `${path}.${key}` : key, fields);
}

function defaultStyle(): PaintStyle {
	return { foreground: DEFAULT_COLOR, background: DEFAULT_COLOR, attributes: { ...DEFAULT_ATTRIBUTES } };
}

function emptyCell(): TerminalCell {
	return { grapheme: " ", width: 1, foreground: DEFAULT_COLOR, background: DEFAULT_COLOR, attributes: { ...DEFAULT_ATTRIBUTES } };
}

function styledCell(grapheme: string, width: 0 | 1 | 2, style: PaintStyle): TerminalCell {
	return { grapheme, width, foreground: { ...style.foreground }, background: { ...style.background }, attributes: { ...style.attributes } };
}

function cloneCell(cell: TerminalCell): TerminalCell {
	return { ...cell, foreground: { ...cell.foreground }, background: { ...cell.background }, attributes: { ...cell.attributes } };
}

function cloneStyle(style: PaintStyle): PaintStyle {
	return { foreground: { ...style.foreground }, background: { ...style.background }, attributes: { ...style.attributes } };
}

function sameCell(left: TerminalCell, right: TerminalCell): boolean {
	return left.grapheme === right.grapheme
		&& left.width === right.width
		&& sameColor(left.foreground, right.foreground)
		&& sameColor(left.background, right.background)
		&& sameAttributes(left.attributes, right.attributes);
}

function sameColor(left: TerminalColor, right: TerminalColor): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "default" && right.kind === "default") return true;
	if (left.kind === "indexed" && right.kind === "indexed") return left.index === right.index;
	return left.kind === "rgb" && right.kind === "rgb" && left.r === right.r && left.g === right.g && left.b === right.b;
}

function sameAttributes(left: CellAttributes, right: CellAttributes): boolean {
	return left.bold === right.bold
		&& left.dim === right.dim
		&& left.italic === right.italic
		&& left.underline === right.underline
		&& left.blink === right.blink
		&& left.inverse === right.inverse
		&& left.hidden === right.hidden
		&& left.strikethrough === right.strikethrough;
}

function sameCursor(left: TerminalFrame["cursor"], right: TerminalFrame["cursor"]): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.x === right.x && left.y === right.y && left.visible === right.visible && left.shape === right.shape;
}

function normalizeDimension(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
	return Math.floor(value);
}

function assertPngSignature(bytes: Uint8Array): void {
	if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) throw new Error("invalid PNG signature");
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function ascii(bytes: Uint8Array): string {
	return String.fromCharCode(...bytes);
}

function unfilterByte(filter: number, raw: number, left: number, up: number, upLeft: number): number {
	if (filter === 0) return raw;
	if (filter === 1) return (raw + left) & 0xff;
	if (filter === 2) return (raw + up) & 0xff;
	if (filter === 3) return (raw + Math.floor((left + up) / 2)) & 0xff;
	if (filter === 4) return (raw + paeth(left, up, upLeft)) & 0xff;
	throw new Error(`unsupported PNG filter ${filter}`);
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const leftDistance = Math.abs(estimate - left);
	const upDistance = Math.abs(estimate - up);
	const diagonalDistance = Math.abs(estimate - upLeft);
	return leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upLeft;
}
