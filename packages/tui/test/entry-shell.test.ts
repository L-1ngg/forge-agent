import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { EntryShell, computeEntryLayout, create256ColorTheme, createSemanticTheme, entryContentStartColumn, frameFromLines } from "../src/index.ts";

test("entry geometry keeps one rail column and reserves a complete timestamp gutter", () => {
	const layout = computeEntryLayout(40, { timestamp: "3:18 PM" });
	expect(layout.railWidth).toBe(1);
	expect(layout.leftPadding).toBe(2);
	expect(layout.rightPadding).toBe(2);
	expect(layout.timestampWidth).toBe(10);
	expect(layout.contentWidth).toBe(25);
	expect(entryContentStartColumn(layout)).toBe(3);
});

test("entry shell wraps user content and fills every row to the viewport width", () => {
	const shell = new EntryShell({
		text: "Inspect the repository and explain the implementation in detail",
		chrome: { surface: "surface", rail: "accent_user", timestamp: "3:18 PM", showPrefix: true, vpadTop: 0, vpadBottom: 0 },
		theme: createSemanticTheme(),
	});
	const lines = shell.render(40);
	expect(lines.length).toBeGreaterThan(1);
	for (const line of lines) expect(visibleWidth(stripTerminalSequences(line))).toBe(40);
	expect(stripTerminalSequences(lines[0] ?? "")).toContain("❯ Inspect");
	expect(stripTerminalSequences(lines[0] ?? "")).toContain("3:18 PM");
});

test("collapsed shell retains its content start column while removing the rail glyph", () => {
	const theme = create256ColorTheme();
	const expanded = new EntryShell({ text: "body", chrome: { rail: "accent_tool", vpadTop: 0, vpadBottom: 0 }, theme });
	const collapsed = new EntryShell({ text: "body", chrome: { rail: "accent_tool", collapsed: true, vpadTop: 0, vpadBottom: 0 }, theme });
	const expandedPlain = stripTerminalSequences(expanded.render(30)[0] ?? "");
	const collapsedPlain = stripTerminalSequences(collapsed.render(30)[0] ?? "");
	expect(expandedPlain.indexOf("body")).toBe(collapsedPlain.indexOf("body"));
	expect(expandedPlain[0]).toBe("┃");
	expect(collapsedPlain[0]).toBe(" ");
});

test("content prefix appears only on the first row and does not indent continuation rows", () => {
	const shell = new EntryShell({
		presentation: {
			rows: [{ text: "first" }, { text: "continuation" }],
			chrome: { contentPrefix: "◆ ", contentPrefixTone: "accent_tool", vpadTop: 0, vpadBottom: 0 },
		},
		theme: createSemanticTheme(),
	});
	const plain = shell.render(30).map((line) => stripTerminalSequences(line));
	expect(plain[0]?.indexOf("◆ first")).toBe(3);
	expect(plain[1]?.indexOf("continuation")).toBe(3);
	expect(plain[1]).not.toContain("◆");
});

test("row backgrounds use row-local columns even when the first row has a prefix", () => {
	const background = { kind: "rgb" as const, r: 1, g: 2, b: 3 };
	const theme = createSemanticTheme({ diff_add: (value) => `\u001b[48;2;1;2;3m${value}\u001b[49m` });
	const shell = new EntryShell({
		presentation: {
			rows: [
				{ text: "abcdef", background: "diff_add", backgroundStart: 2 },
				{ text: "uvwxyz", background: "diff_add", backgroundStart: 2 },
			],
			chrome: { contentPrefix: "◆ ", vpadTop: 0, vpadBottom: 0 },
		},
		theme,
	});
	const frame = frameFromLines(shell.render(20), 20, 2);
	for (const row of frame.cells) {
		expect(row[4]?.background).toEqual({ kind: "default" });
		expect(row[5]?.background).toEqual(background);
	}
});

test("narrow entries hide timestamps completely instead of clipping them", () => {
	const shell = new EntryShell({
		text: "narrow content",
		chrome: { timestamp: "3:18 PM", showPrefix: true, vpadTop: 0, vpadBottom: 0 },
		theme: createSemanticTheme(),
	});
	const plain = shell.render(12).map((line) => stripTerminalSequences(line));
	expect(computeEntryLayout(12, { timestamp: "3:18 PM", showPrefix: true }).timestampWidth).toBe(0);
	expect(plain.join("\n")).not.toContain("3:18 PM");
	expect(plain.join("\n")).not.toContain("3:18");
});

test("entry clipping respects CJK, emoji, and combining grapheme widths", () => {
	const shell = new EntryShell({
		text: "中文🙂e\u0301中文🙂e\u0301中文🙂e\u0301",
		chrome: { showPrefix: true, vpadTop: 0, vpadBottom: 0 },
		theme: createSemanticTheme(),
	});
	const lines = shell.render(18);
	expect(lines.length).toBeGreaterThan(1);
	for (const line of lines) expect(visibleWidth(stripTerminalSequences(line))).toBe(18);
	const frame = frameFromLines(lines, 18, lines.length);
	for (const row of frame.cells) {
		expect(row).toHaveLength(18);
		expect(row[17]?.width).not.toBe(0);
	}
});
