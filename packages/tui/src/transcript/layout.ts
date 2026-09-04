import { visibleWidth } from "@earendil-works/pi-tui";
import type { EntryLayout, EntryLayoutOptions } from "./types.ts";

export const ENTRY_RAIL_WIDTH = 1;
export const ENTRY_LEFT_PADDING = 2;
/** Matches grok-build's default `LayoutConfig.block_pad_right`. */
export const ENTRY_RIGHT_PADDING = 2;
export const ENTRY_TIMESTAMP_RESERVE = 10;

/** Pure Grok-style horizontal geometry. The rail column is stable when collapsed. */
export function computeEntryLayout(width: number, options: EntryLayoutOptions = {}): EntryLayout {
	const totalWidth = Math.max(1, Math.floor(width));
	const leftPadding = Math.max(0, Math.floor(options.leftPadding ?? ENTRY_LEFT_PADDING));
	const rightPadding = Math.max(0, Math.floor(options.rightPadding ?? ENTRY_RIGHT_PADDING));
	const chromeWidth = ENTRY_RAIL_WIDTH + leftPadding + rightPadding;
	const availableContent = Math.max(1, totalWidth - chromeWidth);
	const requestedReserve = options.timestamp ? Math.max(0, Math.floor(options.timestampReserve ?? ENTRY_TIMESTAMP_RESERVE)) : 0;
	const timestampWidth = options.timestamp && availableContent > requestedReserve + 1 && visibleWidth(options.timestamp) <= requestedReserve
		? requestedReserve
		: 0;
	return {
		railWidth: ENTRY_RAIL_WIDTH,
		leftPadding,
		contentWidth: Math.max(1, availableContent - timestampWidth),
		timestampWidth,
		rightPadding,
		totalWidth,
	};
}

export function entryContentStartColumn(layout: EntryLayout): number {
	return layout.railWidth + layout.leftPadding;
}

export function entryTimestampVisible(layout: EntryLayout): boolean {
	return layout.timestampWidth > 0;
}
