import { fillRect, writeText, type CellStyle, type TerminalColor, type TerminalFrame } from "../frame.ts";
import type { Theme } from "../theme.ts";
import { visibleWidth } from "../width.ts";
import type { EntryRow } from "./types.ts";
import type { EntryPresentation } from "./present.ts";

/** Grok-style horizontal geometry: rail 1, left padding 2, right padding 2, timestamp reserve 10. */
export const ENTRY_RAIL_WIDTH = 1;
export const ENTRY_LEFT_PADDING = 2;
export const ENTRY_RIGHT_PADDING = 2;
export const ENTRY_TIMESTAMP_RESERVE = 10;

export interface EntryLayout {
	readonly railWidth: 1;
	readonly leftPadding: number;
	readonly contentWidth: number;
	readonly timestampWidth: number;
	readonly rightPadding: number;
}

/** Content column and timestamp gutter for one entry width. Timestamp is reserved whole or hidden whole. */
export function computeEntryLayout(width: number, timestamp?: string): EntryLayout {
	const totalWidth = Math.max(1, Math.floor(width));
	const leftPadding = ENTRY_LEFT_PADDING;
	const rightPadding = ENTRY_RIGHT_PADDING;
	const chromeWidth = ENTRY_RAIL_WIDTH + leftPadding + rightPadding;
	const available = Math.max(1, totalWidth - chromeWidth);
	const timestampFits = timestamp !== undefined && visibleWidth(timestamp) <= ENTRY_TIMESTAMP_RESERVE && available > ENTRY_TIMESTAMP_RESERVE + 1;
	const timestampWidth = timestampFits ? ENTRY_TIMESTAMP_RESERVE : 0;
	return {
		railWidth: ENTRY_RAIL_WIDTH,
		leftPadding,
		contentWidth: Math.max(1, available - timestampWidth),
		timestampWidth,
		rightPadding,
	};
}

export function entryContentStartColumn(): number {
	return ENTRY_RAIL_WIDTH + ENTRY_LEFT_PADDING;
}

/** Height an entry will occupy once painted by the shell. */
export function entryHeight(presentation: EntryPresentation): number {
	return presentation.chrome.vpadTop + presentation.rows.length + presentation.chrome.vpadBottom;
}

/**
 * Paint one entry: shell owns rail / padding / surface / timestamp gutter /
 * vpad; kind rows only supply spans and optional full-row backgrounds.
 * Rows outside the frame are clipped by the frame itself.
 */
export function paintEntry(frame: TerminalFrame, y: number, presentation: EntryPresentation, theme: Theme): void {
	const { chrome, rows } = presentation;
	const width = frame.columns;
	const layout = computeEntryLayout(width, chrome.timestamp);
	const contentX = entryContentStartColumn();
	const contentRight = contentX + layout.contentWidth;
	const totalRows = chrome.vpadTop + rows.length + chrome.vpadBottom;
	const surface = chrome.surface;

	for (let index = 0; index < totalRows; index++) {
		const lineY = y + index;
		if (lineY < 0 || lineY >= frame.rows) continue;
		if (surface) fillRect(frame, 0, lineY, width, 1, { ...plainStyle(), background: surface });
		if (chrome.rail && !chrome.collapsed) {
			writeText(frame, 0, lineY, "┃", { ...plainStyle(), foreground: chrome.rail, ...(surface ? { background: surface } : {}) });
		}
	}

	for (let index = 0; index < rows.length; index++) {
		const lineY = y + chrome.vpadTop + index;
		if (lineY < 0 || lineY >= frame.rows) continue;
		const entryRow: EntryRow = rows[index]!;
		if (entryRow.background) fillRect(frame, contentX, lineY, layout.contentWidth, 1, { ...plainStyle(), background: entryRow.background });
		let x = contentX;
		for (const span of entryRow.spans) {
			if (x >= contentRight) break;
			x = writeText(frame, x, lineY, span.text, span.style);
		}
		if (index === 0 && layout.timestampWidth > 0 && chrome.timestamp) {
			const timestampX = width - ENTRY_RIGHT_PADDING - visibleWidth(chrome.timestamp);
			writeText(frame, timestampX, lineY, chrome.timestamp, styleOn(theme, "muted", surface));
		}
	}
}

function plainStyle(): CellStyle {
	return {
		foreground: { kind: "default" },
		background: { kind: "default" },
		attributes: { bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false },
	};
}

function styleOn(theme: Theme, slot: Parameters<Theme["color"]>[0], background?: TerminalColor): CellStyle {
	return { ...plainStyle(), foreground: theme.color(slot), ...(background ? { background } : {}) };
}
