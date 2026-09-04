import { defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import { visibleWidth } from "./width.ts";
import type { Theme } from "./theme.ts";

/** Typed shortcut hint (phase-2.1 §2.8): fit whole items, never cut one in half. */
export interface ShortcutHint {
	keys: readonly string[];
	label: string;
	pinned?: boolean;
}

export const SHORTCUT_SEPARATOR = "  │  ";

/**
 * Paint the shortcuts row: pinned routes claim budget first, the rest fill in
 * order; an item either fits completely or is dropped entirely.
 */
export function paintShortcuts(frame: TerminalFrame, y: number, hints: readonly ShortcutHint[], theme: Theme): void {
	if (y >= frame.rows) return;
	const budget = frame.columns - 2;
	const pinned = hints.filter((hint) => hint.pinned);
	const rest = hints.filter((hint) => !hint.pinned);
	let x = 1;
	const keyStyle = { ...defaultStyle(), foreground: theme.color("status") };
	const labelStyle = { ...defaultStyle(), foreground: theme.color("muted") };
	const separatorStyle = { ...defaultStyle(), foreground: theme.color("dim") };
	for (const hint of [...pinned, ...rest]) {
		const item = `${hint.keys.join("+")}:${hint.label}`;
		const itemWidth = visibleWidth(item) + (x > 1 ? visibleWidth(SHORTCUT_SEPARATOR) : 0);
		if (x - 1 + itemWidth > budget) continue;
		if (x > 1) x = writeText(frame, x, y, SHORTCUT_SEPARATOR, separatorStyle);
		x = writeText(frame, x, y, hint.keys.join("+"), keyStyle);
		x = writeText(frame, x, y, `:${hint.label}`, labelStyle);
	}
}
