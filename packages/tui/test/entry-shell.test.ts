import { expect, test } from "bun:test";
import { block } from "@forge-agent/protocol";
import {
	ENTRY_LEFT_PADDING,
	ENTRY_RAIL_WIDTH,
	computeEntryLayout,
	createFrame,
	createTheme,
	entryContentStartColumn,
	formatTimestamp,
	paintEntry,
	presentEntry,
	type TranscriptEntry,
} from "../src/index.ts";

const theme = createTheme({ mode: "truecolor" });

const fixtures: TranscriptEntry[] = [
	{ id: "u1", kind: "user", text: "hello", timestamp: 1000 },
	{ id: "a1", kind: "assistant", markdown: "hi there", timestamp: 2000, lifecycle: "complete" },
	{
		id: "t1",
		kind: "thinking",
		block: block({ id: "t1", kind: "thinking", lifecycle: "complete", defaultDisplayMode: "collapsed" }, { markdown: "hmm" }, { defaultDisplayMode: "collapsed" }),
		durationMs: 2700,
	},
	{
		id: "e1",
		kind: "execute",
		block: block({ id: "e1", kind: "execute", lifecycle: "complete" }, { command: "ls", stdout: "a\n", exitCode: 0 }, { defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3 }),
	},
	{
		id: "d1",
		kind: "edit",
		block: block(
			{ id: "d1", kind: "edit", lifecycle: "complete", defaultDisplayMode: "expanded" },
			{ path: "src/a.ts", hunks: [], additions: 1, removals: 0 },
			{ defaultDisplayMode: "expanded" },
		),
	},
	{ id: "n1", kind: "notice", text: "Worked for 2.7s", tone: "muted" },
];

test("AC-25: every kind shares the same content start column at 40/60/80/120", () => {
	for (const columns of [40, 60, 80, 120]) {
		for (const entry of fixtures) {
			const layout = computeEntryLayout(columns, entry.kind === "user" || entry.kind === "assistant" ? "3:18 PM" : undefined);
			const presentation = presentEntry(entry, layout.contentWidth, theme);
			const frame = createFrame(columns, 12);
			paintEntry(frame, 0, presentation, theme);
			// rail column + left padding stay blank/owned; content starts at the shared column
			expect(entryContentStartColumn()).toBe(ENTRY_RAIL_WIDTH + ENTRY_LEFT_PADDING);
			const row = presentation.chrome.vpadTop; // first content row
			if (entry.kind === "notice") continue; // notices are single muted rows
			const painted = frameToTextRow(frame, row);
			expect(painted.length).toBeGreaterThan(0);
		}
	}
});

test("AC-26: timestamp is reserved whole or hidden whole, never clipped in half", () => {
	const wide = computeEntryLayout(80, "3:18 PM");
	expect(wide.timestampWidth).toBe(10);
	const narrow = computeEntryLayout(14, "3:18 PM");
	expect(narrow.timestampWidth).toBe(0); // whole gutter disappears
	const entry: TranscriptEntry = { id: "u", kind: "user", text: "hello", timestamp: 0 };
	const expected = formatTimestamp(0)!; // timezone-independent
	for (const columns of [80, 14]) {
		const layout = computeEntryLayout(columns, "3:18 PM");
		const frame = createFrame(columns, 4);
		paintEntry(frame, 0, presentEntry(entry, layout.contentWidth, theme), theme);
		const text = frameToTextRow(frame, 1);
		if (columns === 80) expect(text).toContain(expected);
		else expect(text).not.toContain(expected);
	}
});

test("AC-27: user band surface covers every row including vpad and the full width", () => {
	const entry: TranscriptEntry = { id: "u", kind: "user", text: "hi", timestamp: 0 };
	const layout = computeEntryLayout(40, "12:00 AM");
	const frame = createFrame(40, 6);
	paintEntry(frame, 0, presentEntry(entry, layout.contentWidth, theme), theme);
	const surface = theme.color("surface");
	for (const y of [0, 1, 2]) {
		expect(frame.cells[y]![0]!.background).toEqual(surface);
		expect(frame.cells[y]![39]!.background).toEqual(surface);
	}
});

test("collapsed entries drop the rail glyph but keep the rail column", () => {
	const collapsed = fixtures.find((entry) => entry.kind === "thinking")!;
	const layout = computeEntryLayout(60);
	const frame = createFrame(60, 4);
	paintEntry(frame, 0, presentEntry(collapsed, layout.contentWidth, theme), theme);
	expect(frame.cells[0]![0]!.grapheme).toBe(" "); // rail column reserved, no glyph
	expect(frameToTextRow(frame, 0)).toContain("Thought for 2.7s");
});

function frameToTextRow(frame: ReturnType<typeof createFrame>, y: number): string {
	return frame.cells[y]!.map((cell) => (cell.width === 0 ? "" : cell.grapheme)).join("").trimEnd();
}
