import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { diffFrames, styledJsonToIndexedFrame, styledJsonToResolvedFrame } from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "upstream");

test("styled JSON converter preserves the upstream welcome viewport and RGB styles", async () => {
	const source = await readFile(join(FIXTURES, "welcome-100x32.styled.json"), "utf8");
	const frame = styledJsonToResolvedFrame(source);
	expect(frame.columns).toBe(100);
	expect(frame.rows).toBe(32);
	expect(frame.cells[0]?.[0]?.background).toEqual({ kind: "rgb", r: 18, g: 18, b: 18 });
	expect(frame.cells[8]?.[6]?.grapheme).toBe("⠀");
	expect(frame.cells[8]?.[23]?.grapheme).toBe("G");
	expect(frame.cells[8]?.[23]?.attributes.bold).toBe(true);
	expect(frame.cells[26]?.[2]?.grapheme).toBe("╭");
	expect(frame.cells[27]?.[4]?.grapheme).toBe("❯");
});

test("styled JSON converter quantizes every RGB run as one explicit ANSI256 frame", async () => {
	const source = await readFile(join(FIXTURES, "welcome-100x32.styled.json"), "utf8");
	const frame = styledJsonToIndexedFrame(source);
	expect(frame.cells[0]?.[0]?.background).toEqual({ kind: "indexed", index: 233 });
	expect(frame.cells[6]?.[3]?.foreground).toEqual({ kind: "indexed", index: 236 });
	expect(frame.cells[8]?.[23]?.foreground).toEqual({ kind: "indexed", index: 254 });
	expect(frame.cells.every((row) => row.length === 100)).toBe(true);
});

test("styled JSON converter supports resize and mock response artifacts", async () => {
	const [welcome, response] = await Promise.all([
		readFile(join(FIXTURES, "welcome-90x28.styled.json"), "utf8"),
		readFile(join(FIXTURES, "mock-response-110x40.styled.json"), "utf8"),
	]);
	const resized = styledJsonToResolvedFrame(welcome, { columns: 90, rows: 28 });
	const mocked = styledJsonToResolvedFrame(response);
	expect(resized.columns).toBe(90);
	expect(resized.rows).toBe(28);
	expect(mocked.columns).toBe(110);
	expect(mocked.rows).toBe(40);
	expect(mocked.cells[4]?.some((cell) => cell.grapheme === "❯")).toBe(true);
	expect(mocked.cells[38]?.map((cell) => cell.grapheme).join("")).toContain("Shift+Tab");
});

test("styled JSON conversion is deterministic and rejects malformed viewport data", async () => {
	const source = await readFile(join(FIXTURES, "welcome-90x28.styled.json"), "utf8");
	const first = styledJsonToResolvedFrame(source);
	const second = styledJsonToResolvedFrame(source);
	expect(diffFrames(first, second)).toMatchObject({ equal: true, differingCells: 0 });
	expect(() => styledJsonToResolvedFrame(source, { columns: 89 })).toThrow("exceeds viewport width");
	expect(() => styledJsonToResolvedFrame(JSON.stringify([{ line: 2, runs: [] }]))).toThrow("contiguous and 1-based");
	expect(() => styledJsonToResolvedFrame(JSON.stringify([{ line: 1, runs: [{ text: "x", fg: "red" }] }]))).toThrow("invalid styled JSON color");
});
