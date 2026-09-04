import { expect, test } from "bun:test";
import { computeScreenLayout, fitInteractiveRegion, fitShortcutHints, renderShortcutHints, create256ColorTheme, renderStatusDock } from "../src/index.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

test("screen layout exposes upstream outer padding and keeps every painted row inside the inner viewport", () => {
	const normal = computeScreenLayout({ columns: 40, rows: 40, headerVisible: true, statusVisible: true, interactiveDesired: 3 });
	expect(normal.outer).toEqual({ top: 1, bottom: 1, left: 2, right: 2 });
	expect(normal.inner).toEqual({ top: 1, height: 38, width: 36 });
	const compact = computeScreenLayout({ columns: 40, rows: 20, headerVisible: true, statusVisible: true, interactiveDesired: 3 });
	expect(compact.outer).toEqual({ top: 0, bottom: 0, left: 1, right: 1 });
	expect(compact.inner).toEqual({ top: 0, height: 20, width: 38 });
	expect(compact.interactive.top).toBe(compact.transcript.top + compact.transcript.height);
	const short = computeScreenLayout({ columns: 40, rows: 16, headerVisible: true, statusVisible: true, interactiveDesired: 3 });
	expect(short.outer.bottom).toBe(0);
	expect(short.interactive.top).toBe(short.transcript.top + short.transcript.height);
	const normalWithoutStatus = computeScreenLayout({ columns: 40, rows: 40, headerVisible: false, statusVisible: false, interactiveDesired: 3 });
	expect(normalWithoutStatus.interactive.top).toBe(normalWithoutStatus.transcript.top + normalWithoutStatus.transcript.height + 1);
	for (const plan of [normal, compact, short]) {
		const regions = [plan.header, plan.transcript, plan.interactive, plan.status, plan.shortcuts];
		expect(regions.every((region) => region.top >= plan.inner.top && region.top + region.height <= plan.inner.top + plan.inner.height)).toBe(true);
	}
});

test("non-positive row dimensions do not expose phantom outer padding", () => {
	const plan = computeScreenLayout({ columns: 40, rows: 0, headerVisible: true, statusVisible: true });
	expect(plan.outer).toEqual({ top: 0, bottom: 0, left: 2, right: 2 });
	expect(plan.inner).toEqual({ top: 0, height: 0, width: 36 });
});

for (const rows of [8, 12, 16, 20, 24, 40]) {
	test(`screen layout consumes a bounded ${rows}-row viewport`, () => {
		const plan = computeScreenLayout({ rows, headerVisible: true, statusVisible: true, interactiveDesired: 6, transcriptDesired: 12, interactiveOwner: "composer" });
		const regions = [plan.header, plan.transcript, plan.interactive, plan.status, plan.shortcuts];
		expect(regions.every((region) => region.height >= 0 && region.top >= 0)).toBe(true);
		expect(regions.reduce((sum, region) => sum + region.height, 0)).toBeLessThanOrEqual(rows);
		expect(plan.shortcuts.height).toBe(rows > 0 ? 1 : 0);
		expect(plan.interactive.owner).toBe("composer");
	});
}

test("card and composer share one interactive slot", () => {
	const composer = computeScreenLayout({ rows: 24, interactiveOwner: "composer", interactiveDesired: 4 });
	const card = computeScreenLayout({ rows: 24, interactiveOwner: "card", interactiveDesired: 4 });
	expect(card.interactive).toEqual({ ...composer.interactive, owner: "card" });
	expect(card.transcript).toEqual(composer.transcript);
});

test("shortcuts fit complete hints and preserve a pinned escape route", () => {
	const theme = create256ColorTheme();
	const hints = [
		{ keys: ["Ctrl+C"], label: "exit", pinned: true },
		{ keys: ["Enter"], label: "send" },
		{ keys: ["Ctrl+O"], label: "fold" },
	];
	const fitted = fitShortcutHints(hints, 18, theme);
	expect(fitted[0]?.hint.pinned).toBe(true);
	expect(renderShortcutHints(hints, 18, theme)).toContain("Ctrl+C");
	expect(renderShortcutHints(hints, 18, theme)).not.toContain("Ctrl+O");
});

test("overflowing cards keep their title and action tail in the interactive slot", () => {
	const lines = ["", "Permission", "detail one", "detail two", "detail three", "", "> 1. allow  2. deny", ""];
	expect(fitInteractiveRegion(lines, 4, 40, "card").map((line) => line.trim())).toEqual([
		"Permission",
		"detail three",
		"",
		"> 1. allow  2. deny",
	]);
	expect(fitInteractiveRegion(lines, 4, 40, "composer").map((line) => line.trim())).toEqual(["", "Permission", "detail one", "detail two"]);
});

test("status dock preserves segment order and the exact upstream separator", () => {
	const line = renderStatusDock(80, [
		{ text: "project", styled: "project" },
		{ text: "Grok Build", styled: "Grok Build" },
		{ text: "42% ctx", styled: "42% ctx" },
		{ text: "$0.37", styled: "$0.37" },
	]);
	expect(line).toEqual(["project │ Grok Build │ 42% ctx │ $0.37"]);
});

test("status dock clips the composed row with one ellipsis and keeps ANSI styles valid", () => {
	const styled = "\u001b[38;2;122;162;247mproject\u001b[39m";
	const line = renderStatusDock(16, [
		{ text: "project", styled },
		{ text: "Grok Build", styled: "\u001b[38;2;225;225;225mGrok Build\u001b[39m" },
		{ text: "42% ctx", styled: "42% ctx" },
	]);
	expect(line).toHaveLength(1);
	expect(visibleWidth(stripTerminalSequences(line[0] ?? ""))).toBeLessThanOrEqual(16);
	expect(stripTerminalSequences(line[0] ?? "")).toEndWith("…");
	expect(line[0]).toContain("\u001b[");
});

test("status dock has explicit empty and zero-width behavior", () => {
	expect(renderStatusDock(0, [{ text: "x", styled: "x" }])).toEqual([]);
	expect(renderStatusDock(80, [])).toEqual([]);
	expect(stripTerminalSequences(renderStatusDock(3, [{ text: "long", styled: "long" }])[0] ?? "")).toBe("lo…");
});
