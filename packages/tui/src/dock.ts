import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SemanticTheme } from "./theme.ts";

export interface ShortcutHint {
	keys: readonly string[];
	label: string;
	pinned?: boolean;
}

export interface RenderedShortcut {
	hint: ShortcutHint;
	text: string;
	width: number;
}

export function fitShortcutHints(hints: readonly ShortcutHint[], width: number, theme?: SemanticTheme): RenderedShortcut[] {
	const safeWidth = Math.max(0, Math.floor(width));
	const ordered = [...hints].sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true));
	const result: RenderedShortcut[] = [];
	let used = 0;
	for (const hint of ordered) {
		const key = hint.keys.join("/");
		const plain = `${key}:${hint.label}`;
		const separator = result.length === 0 ? 0 : 5;
		if (used + separator + visibleWidth(plain) > safeWidth) continue;
		const keyText = theme === undefined ? key : boldShortcutKey(theme, key);
		const labelText = theme?.muted(hint.label) ?? hint.label;
		const text = `${keyText}:${labelText}`;
		result.push({ hint, text, width: visibleWidth(plain) });
		used += separator + visibleWidth(plain);
	}
	return result;
}

export function renderShortcutHints(hints: readonly ShortcutHint[], width: number, theme?: SemanticTheme): string {
	const separator = theme === undefined ? "  │  " : `\u001b[2m${theme.muted("  │  ")}\u001b[22m`;
	return fitShortcutHints(hints, width, theme).map((item) => item.text).join(separator);
}

/** One-row dock component. It never truncates a partially visible hint. */
export class ShortcutsDock implements Component {
	private hints: readonly ShortcutHint[];
	private readonly theme: SemanticTheme | undefined;

	constructor(hints: readonly ShortcutHint[] = [], theme?: SemanticTheme) {
		this.hints = [...hints];
		this.theme = theme;
	}

	setHints(hints: readonly ShortcutHint[]): void {
		this.hints = [...hints];
	}

	getHints(): readonly ShortcutHint[] {
		return [...this.hints];
	}

	render(width: number): string[] {
		const line = renderShortcutHints(this.hints, width, this.theme);
		return line ? [truncateToWidth(line, Math.max(0, Math.floor(width)), "")] : [];
	}

	invalidate(): void {}
}

/** Match ShortcutsBar's bright/bold key run while keeping identity themes unstyled. */
function boldShortcutKey(theme: SemanticTheme, key: string): string {
	const styled = theme.status(key);
	return styled === key ? styled : `\u001b[1m${styled}\u001b[22m`;
}

/** Clip a dock region while keeping a blocking card's title and action tail reachable. */
export function fitInteractiveRegion(lines: readonly string[], height: number, width: number, owner: "composer" | "card"): string[] {
	const safeHeight = Math.max(0, Math.floor(height));
	const safeWidth = Math.max(1, Math.floor(width));
	let selected = lines.slice(0, safeHeight);
	if (owner === "card" && lines.length > safeHeight && safeHeight > 0) selected = pinnedCardLines(lines, safeHeight);
	const fitted = selected.map((line) => truncateToWidth(line, safeWidth, "", true));
	while (fitted.length < safeHeight) fitted.push(" ".repeat(safeWidth));
	return fitted;
}

function pinnedCardLines(lines: readonly string[], height: number): string[] {
	const first = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
	let last = lines.length - 1;
	while (last >= 0 && stripTerminalSequences(lines[last] ?? "").trim().length === 0) last--;
	if (last < 0) return lines.slice(-height);
	if (height === 1 || first < 0 || first === last) return [lines[last] ?? ""];
	const tailStart = Math.max(first + 1, last - (height - 2));
	return [lines[first] ?? "", ...lines.slice(tailStart, last + 1)].slice(-height);
}
