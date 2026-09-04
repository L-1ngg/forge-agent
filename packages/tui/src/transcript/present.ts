import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { SemanticTheme, ThemeSlot } from "../theme.ts";
import { computeEntryLayout } from "./layout.ts";
import type { EntryChrome, EntryLayout, EntryPresentation, EntryRow } from "./types.ts";

export interface BodyPresentationOptions {
	textWidth: number;
	wrap?: boolean;
}

/** Convert component rows into shell-owned presentation rows without changing ANSI styles. */
export function rowsFromComponent(component: Component, options: BodyPresentationOptions): EntryRow[] {
	const rows = component.render(Math.max(1, Math.floor(options.textWidth)));
	if (options.wrap === false) return rows.map((row) => ({ text: truncateToWidth(row, options.textWidth), logicalLineStart: true }));
	return rows.flatMap((row) => wrapAnsiRow(row, options.textWidth).map((text, index) => ({ text, logicalLineStart: index === 0 })));
}

export function rowsFromText(text: string, width: number): EntryRow[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return text.split("\n").flatMap((line) => wrapAnsiRow(line, safeWidth).map((value, index) => ({ text: value, logicalLineStart: index === 0 })));
}

export function presentationFromRows(rows: readonly EntryRow[], chrome: Partial<EntryChrome> = {}): EntryPresentation {
	return {
		rows: [...rows],
		chrome: {
			vpadTop: chrome.vpadTop ?? 0,
			vpadBottom: chrome.vpadBottom ?? 0,
			...(chrome.rail === undefined ? {} : { rail: chrome.rail }),
			...(chrome.surface === undefined ? {} : { surface: chrome.surface }),
			...(chrome.timestamp === undefined ? {} : { timestamp: chrome.timestamp }),
			...(chrome.showPrefix === undefined ? {} : { showPrefix: chrome.showPrefix }),
			...(chrome.contentPrefix === undefined ? {} : { contentPrefix: chrome.contentPrefix }),
			...(chrome.contentPrefixTone === undefined ? {} : { contentPrefixTone: chrome.contentPrefixTone }),
			...(chrome.collapsed === undefined ? {} : { collapsed: chrome.collapsed }),
		},
	};
}

export function wrapAnsiRow(row: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const wrapped = wrapTextWithAnsi(row, safeWidth);
	return wrapped.length > 0 ? wrapped.map((line) => truncateToWidth(line, safeWidth)) : [""];
}

export function renderPlainEntryRows(presentation: EntryPresentation, width: number, theme: SemanticTheme): string[] {
	const layout = computeEntryLayout(width, presentation.chrome);
	const configuredPrefix = presentation.chrome.showPrefix ? "❯ " : presentation.chrome.contentPrefix ?? "";
	const prefixWidth = visibleWidth(configuredPrefix);
	const contentRows = presentation.rows.map((row, logicalIndex) => {
		const reservedPrefix = presentation.chrome.showPrefix || logicalIndex === 0 ? prefixWidth : 0;
		const textWidth = Math.max(1, layout.contentWidth - reservedPrefix);
		const firstContentRow = logicalIndex === 0;
		return {
			text: truncateToWidth(row.text, textWidth, "", false),
			prefix: firstContentRow ? configuredPrefix : presentation.chrome.showPrefix ? " ".repeat(prefixWidth) : "",
			textWidth,
			...(row.background === undefined ? {} : { background: row.background }),
			...(row.backgroundStart === undefined ? {} : { backgroundStart: row.backgroundStart }),
		};
	});
	const rows: Array<{ text: string; prefix: string; textWidth: number; background?: ThemeSlot; backgroundStart?: number; rail: boolean }> = [];
	for (let index = 0; index < presentation.chrome.vpadTop; index++) rows.push({ text: "", prefix: "", textWidth: layout.contentWidth, rail: !presentation.chrome.collapsed });
	for (const [index, row] of contentRows.entries()) {
		const base = { text: row.text, prefix: row.prefix, textWidth: row.textWidth, rail: !presentation.chrome.collapsed };
		rows.push(row.background === undefined
			? base
			: { ...base, background: row.background, ...(row.backgroundStart === undefined ? {} : { backgroundStart: row.backgroundStart }) });
	}
	for (let index = 0; index < presentation.chrome.vpadBottom; index++) rows.push({ text: "", prefix: "", textWidth: layout.contentWidth, rail: !presentation.chrome.collapsed });
	if (rows.length === 0) rows.push({ text: "", prefix: "", textWidth: layout.contentWidth, rail: false });

	return rows.map((row, rowIndex) => {
		const isFirstContentRow = rowIndex === presentation.chrome.vpadTop;
		const rawPrefix = row.prefix;
		const prefix = rawPrefix && presentation.chrome.contentPrefixTone
			? themeColor(theme, presentation.chrome.contentPrefixTone)(rawPrefix)
			: rawPrefix;
		const text = `${prefix}${truncateToWidth(row.text, row.textWidth, "", false)}`;
		const timestamp = isFirstContentRow && layout.timestampWidth > 0 ? presentation.chrome.timestamp ?? "" : "";
		const timestampText = timestamp ? truncateToWidth(timestamp, layout.timestampWidth, "", false) : "";
		const timestampSegment = timestampText
			? `${" ".repeat(Math.max(0, layout.timestampWidth - visibleWidth(timestampText)))}${theme.muted(timestampText)}`
			: " ".repeat(layout.timestampWidth);
		const content = `${text}${" ".repeat(Math.max(0, layout.contentWidth - visibleWidth(text)))}${timestampSegment}`;
		const rail = row.rail && presentation.chrome.rail ? themeColor(theme, presentation.chrome.rail)("┃") : " ";
		const left = " ".repeat(layout.leftPadding);
		const right = " ".repeat(layout.rightPadding);
		const line = `${rail}${left}${content}${right}`;
		if (row.background) {
			const start = clampColumn(row.backgroundStart ?? 0, layout.contentWidth);
			const prefixSegment = `${rail}${left}${sliceByColumn(content, 0, start, true)}`;
			const painted = sliceByColumn(content, start, Math.max(0, layout.contentWidth - start), true);
			return `${prefixSegment}${themeColor(theme, row.background)(painted)}${right}`;
		}
		return presentation.chrome.surface ? themeColor(theme, presentation.chrome.surface)(line) : line;
	});
}

function clampColumn(value: number, width: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(width, Math.max(0, Math.floor(value)));
}

function themeColor(theme: SemanticTheme, slot: ThemeSlot): (text: string) => string {
	return theme[slot] ?? ((text: string) => text);
}
