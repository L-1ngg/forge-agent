import { expect, test } from "bun:test";
import { HIDE_CURSOR, SHOW_CURSOR, SYNC_OUTPUT_BEGIN, SYNC_OUTPUT_END, cursorPosition, paintDiff, styleToSgr } from "../src/ansi.ts";
import { cloneFrame, createFrame, defaultStyle, setCursor, writeText, type CellStyle } from "../src/index.ts";

const red: CellStyle = { foreground: { kind: "rgb", r: 247, g: 118, b: 142 }, background: { kind: "default" }, attributes: { bold: true, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false } };

test("styleToSgr covers truecolor, indexed, default and attributes", () => {
	expect(styleToSgr(red)).toBe("\x1b[0m\x1b[1;38;2;247;118;142;49m");
	expect(styleToSgr({ ...red, foreground: { kind: "indexed", index: 203 } })).toContain("38;5;203");
	expect(styleToSgr(defaultStyle())).toBe("\x1b[0m\x1b[39;49m");
});

test("first paint writes every row", () => {
	const frame = createFrame(4, 2);
	writeText(frame, 0, 1, "hi");
	const out = paintDiff(null, frame);
	expect(out).toContain(cursorPosition(0, 0));
	expect(out).toContain(cursorPosition(0, 1));
	expect(out).toContain("hi");
	expect(out).toContain(HIDE_CURSOR); // no cursor set
});

test("diff paint touches only the changed cell", () => {
	const before = createFrame(10, 3);
	writeText(before, 0, 0, "keep");
	writeText(before, 0, 2, "stay");
	const after = cloneFrame(before);
	writeText(after, 4, 1, "X", red);
	const out = paintDiff(before, after);
	expect(out).toContain(cursorPosition(4, 1));
	expect(out).toContain("X");
	expect(out).not.toContain("keep");
	expect(out).not.toContain("stay");
	expect(out.match(/\x1b\[\d+;\d+H/g)).toHaveLength(1); // one cursor move, no cursor set
});

test("diff paint repositions to the head when a continuation cell changes", () => {
	const before = createFrame(6, 1);
	writeText(before, 0, 0, "ab");
	const after = createFrame(6, 1);
	writeText(after, 0, 0, "a你");
	const out = paintDiff(before, after);
	expect(out).toContain(cursorPosition(1, 0));
	expect(out).toContain("你");
	expect(out).not.toContain(cursorPosition(2, 0)); // continuation never addressed alone
});

test("cursor state drives position, shape and visibility sequences", () => {
	const frame = createFrame(4, 1);
	setCursor(frame, 2, 0, "bar");
	const out = paintDiff(null, frame);
	expect(out).toContain(cursorPosition(2, 0));
	expect(out).toContain("\x1b[6 q");
	expect(out).toContain(SHOW_CURSOR);
});

test("synchronized output wraps the stream", () => {
	const frame = createFrame(2, 1);
	const out = paintDiff(null, frame, { synchronized: true });
	expect(out.startsWith(SYNC_OUTPUT_BEGIN)).toBe(true);
	expect(out.endsWith(SYNC_OUTPUT_END)).toBe(true);
});

test("hidden cells paint as blanks", () => {
	const frame = createFrame(3, 1);
	writeText(frame, 0, 0, "s", { ...red, attributes: { ...red.attributes, hidden: true } });
	expect(paintDiff(null, frame)).not.toContain("s");
});
