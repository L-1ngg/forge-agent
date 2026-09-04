import { expect, test } from "bun:test";
import { cloneFrame, createFrame, diffFrames, dumpFrame, fillRect, frameToText, hideCursor, serializeFrame, setCursor, writeText, type CellStyle } from "../src/index.ts";

const style: CellStyle = { foreground: { kind: "rgb", r: 1, g: 2, b: 3 }, background: { kind: "default" }, attributes: { bold: true, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false } };

test("createFrame allocates blank cells", () => {
	const frame = createFrame(4, 2);
	expect(frame.columns).toBe(4);
	expect(frame.rows).toBe(2);
	expect(frame.cells[1]![3]).toMatchObject({ grapheme: " ", width: 1 });
});

test("writeText paints ASCII and returns the end column", () => {
	const frame = createFrame(10, 3);
	const end = writeText(frame, 2, 1, "abc", style);
	expect(end).toBe(5);
	expect(frame.cells[1]![2]).toMatchObject({ grapheme: "a", width: 1 });
	expect(frame.cells[1]![4]!.foreground).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
	expect(frameToText(frame).split("\n")[1]).toBe("  abc");
});

test("wide graphemes occupy a head and a continuation cell", () => {
	const frame = createFrame(6, 1);
	const end = writeText(frame, 0, 0, "你好");
	expect(end).toBe(4);
	expect(frame.cells[0]![0]).toMatchObject({ grapheme: "你", width: 2 });
	expect(frame.cells[0]![1]).toMatchObject({ grapheme: "", width: 0 });
	expect(frame.cells[0]![2]).toMatchObject({ grapheme: "好", width: 2 });
});

test("a wide grapheme that does not fit is clipped, never split", () => {
	const frame = createFrame(3, 1);
	writeText(frame, 2, 0, "你");
	expect(frame.cells[0]![2]).toMatchObject({ grapheme: " ", width: 1 });
	expect(writeText(frame, 0, 0, "ab你")).toBe(2); // clipped at the edge, cursor stays
	expect(frameToText(frame)).toBe("ab");
});

test("zero-width graphemes attach to the cell on the left", () => {
	const frame = createFrame(4, 1);
	const end = writeText(frame, 0, 0, "é!");
	expect(end).toBe(2);
	expect(frame.cells[0]![0]!.grapheme).toBe("é");
	expect(frame.cells[0]![1]!.grapheme).toBe("!");
});

test("overwriting either half of a wide grapheme repairs the other half", () => {
	const frame = createFrame(6, 1);
	writeText(frame, 1, 0, "你");
	writeText(frame, 2, 0, "a"); // onto the continuation cell
	expect(frame.cells[0]![1]).toMatchObject({ grapheme: " ", width: 1 });
	expect(frame.cells[0]![2]).toMatchObject({ grapheme: "a", width: 1 });
	writeText(frame, 0, 0, "你");
	writeText(frame, 0, 0, "b"); // onto the head cell
	expect(frame.cells[0]![0]).toMatchObject({ grapheme: "b", width: 1 });
	expect(frame.cells[0]![1]).toMatchObject({ grapheme: " ", width: 1 });
});

test("fillRect blanks a region with a style", () => {
	const frame = createFrame(4, 2);
	writeText(frame, 0, 0, "abcd");
	fillRect(frame, 1, 0, 2, 1, style);
	expect(frameToText(frame).split("\n")[0]).toBe("a  d");
	expect(frame.cells[0]![1]!.background).toEqual({ kind: "default" });
	expect(frame.cells[0]![1]!.attributes.bold).toBe(true);
});

test("diffFrames finds nothing for clones and exactly one cell for a one-cell change", () => {
	const before = createFrame(5, 2);
	writeText(before, 0, 0, "hello");
	const after = cloneFrame(before);
	expect(diffFrames(before, after).equal).toBe(true);
	// Reverse verification primitive: change one cell, the diff must go red.
	after.cells[0]![2] = { ...after.cells[0]![2]!, grapheme: "x" };
	const diff = diffFrames(before, after);
	expect(diff.equal).toBe(false);
	expect(diff.differences).toHaveLength(1);
	expect(diff.differences[0]).toMatchObject({ x: 2, y: 0 });
});

test("diffFrames tracks cursor and dimension changes", () => {
	const a = createFrame(5, 2);
	const b = cloneFrame(a);
	setCursor(b, 1, 1, "bar");
	expect(diffFrames(a, b).cursorMismatch).toBe(true);
	hideCursor(a);
	hideCursor(b);
	expect(diffFrames(a, b).cursorMismatch).toBe(false);
	expect(diffFrames(a, createFrame(6, 2)).dimensionMismatch).toBe(true);
});

test("dumpFrame/serializeFrame produce the stable parity schema", () => {
	const frame = createFrame(3, 1);
	writeText(frame, 0, 0, "a你");
	setCursor(frame, 3, 0, "block");
	const dump = dumpFrame(frame);
	expect(dump.columns).toBe(3);
	expect(dump.cells[0]![0]).toMatchObject({ grapheme: "a", width: 1 });
	expect(dump.cells[0]![1]).toMatchObject({ grapheme: "你", width: 2 });
	expect(dump.cursor).toMatchObject({ x: 3, y: 0, visible: true, shape: "block" });
	expect(serializeFrame(frame)).toBe(JSON.stringify(dump));
});
