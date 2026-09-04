import { expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { block } from "@myh/protocol";
import { EditBlock, ExecuteBlock, ThinkingBlock, componentForBlock, createSemanticTheme, frameFromLines } from "../src/index.ts";

test("thinking block keeps a manual fold while streaming content changes", () => {
	const thinking = new ThinkingBlock({ markdown: "one\ntwo\nthree\nfour" });
	thinking.toggle();
	expect(thinking.displayMode).toBe("collapsed");
	thinking.setText("one\ntwo\nthree\nfour\nfive");
	expect(thinking.displayMode).toBe("collapsed");
	expect(thinking.render(80)).toHaveLength(1);
	thinking.clearManualOverride();
	expect(thinking.displayMode).toBe("truncated");
	const plain = stripTerminalSequences(thinking.render(80).join("\n"));
	expect(plain).toBe("Thought\n\n…\nthree\nfour\nfive");
});

test("execute block preserves the head and tail when truncated", () => {
	const execute = new ExecuteBlock({ command: "run", stdout: "a\nb\nc\nd\ne\nf", defaultDisplayMode: "truncated" });
	const rendered = execute.render(80).join("\n");
	expect(rendered).toContain("Run run");
	expect(rendered).toContain("a");
	expect(rendered).toContain("b");
	expect(rendered).toContain("e");
	expect(rendered).toContain("f");
	expect(rendered).toContain("… +1 lines");
});

test("execute block supports zero head or tail lines without duplicating output", () => {
	const headOnly = new ExecuteBlock({ command: "run", stdout: "a\nb\nc", firstLines: 2, lastLines: 0, defaultDisplayMode: "truncated" });
	expect(headOnly.render(80).join("\n")).toBe("Run run\n\na\nb\n… +1 lines");

	const tailOnly = new ExecuteBlock({ command: "run", stdout: "a\nb\nc", firstLines: 0, lastLines: 1, defaultDisplayMode: "truncated" });
	expect(tailOnly.render(80).join("\n")).toBe("Run run\n\n… +2 lines\nc");
});

test("edit block renders core hunks and +/- counts without recomputing them", () => {
	const data = {
		path: "file.ts",
		hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, additions: 1, removals: 1, lines: [
			{ type: "remove" as const, content: "old", oldLine: 1 },
			{ type: "add" as const, content: "new", newLine: 1 },
		] }],
		additions: 1,
		removals: 1,
	};
	const edit = new EditBlock(block({ id: "edit-1", kind: "edit" }, data));
	const rendered = edit.render(80).join("\n");
	expect(rendered).toContain("Edit file.ts");
	expect(rendered).not.toContain("+1/-1");
	expect(rendered).not.toContain("@@");
	expect(rendered).toContain("1  old");
	expect(rendered).toContain("1  new");
});

test("collapsed edit uses the basename and keeps the diffstat", () => {
	const edit = new EditBlock({
		path: "src/deep/file.ts",
		hunks: [],
		additions: 2,
		removals: 1,
		defaultDisplayMode: "collapsed",
	});
	const plain = stripTerminalSequences(edit.render(80).join("\n"));
	expect(plain).toBe("Edit file.ts +2/-1");
});

test("expanded edit keeps each hunk's independent gutter and exact separator", () => {
	const edit = new EditBlock({
		path: "file.ts",
		hunks: [
			{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, additions: 1, removals: 0, lines: [{ type: "add", content: "short", newLine: 1 }] },
			{ oldStart: 100, oldLines: 1, newStart: 100, newLines: 1, additions: 1, removals: 0, lines: [{ type: "add", content: "later", newLine: 100 }] },
		],
		additions: 2,
		removals: 0,
		defaultDisplayMode: "expanded",
	});
	const plain = stripTerminalSequences(edit.render(80).join("\n"));
	expect(plain).toContain("  1  short");
	expect(plain).toContain("  100  later");
	expect(plain).toContain("  … 98 unchanged lines");
	expect(plain).not.toContain("+2/-0");
	expect(plain).not.toContain("@@");
});

test("wrapped edit rows keep an equal-width blank continuation gutter", () => {
	const edit = new EditBlock({
		path: "file.ts",
		hunks: [{
			oldStart: 1,
			oldLines: 0,
			newStart: 1,
			newLines: 1,
			additions: 1,
			removals: 0,
			lines: [{ type: "add", content: "alpha beta gamma delta epsilon", newLine: 1 }],
		}],
		additions: 1,
		removals: 0,
		defaultDisplayMode: "expanded",
	});
	const diffRows = edit.render(18).map((line) => stripTerminalSequences(line)).slice(2);
	expect(diffRows).toEqual([
		"  1  alpha beta",
		"     gamma delta",
		"     epsilon",
	]);
});

test("edit rows expand every tab to exactly four spaces", () => {
	const edit = new EditBlock({
		path: "file.ts",
		hunks: [{
			oldStart: 1,
			oldLines: 0,
			newStart: 1,
			newLines: 1,
			additions: 1,
			removals: 0,
			lines: [{ type: "add", content: "\tfoo\tbar", newLine: 1 }],
		}],
		additions: 1,
		removals: 0,
		defaultDisplayMode: "expanded",
	});
	const row = stripTerminalSequences(edit.render(40)[2] ?? "");
	expect(row).toBe("  1      foo    bar");
	expect(row).not.toContain("\t");
});

test("error-only execute output has one separator and no stdout panel", () => {
	const panel = { kind: "rgb" as const, r: 7, g: 8, b: 9 };
	const execute = new ExecuteBlock({
		command: "run",
		stderr: "boom",
		defaultDisplayMode: "expanded",
		theme: createSemanticTheme({ stdout_panel: (value) => `\u001b[48;2;7;8;9m${value}\u001b[49m` }),
	});
	const lines = execute.render(30);
	expect(lines.map((line) => stripTerminalSequences(line))).toEqual(["Run run", "", "boom"]);
	const frame = frameFromLines(lines, 30, lines.length);
	for (const row of frame.cells) {
		for (const cell of row) expect(cell.background).not.toEqual(panel);
	}
});

test("block envelope preserves its initial fold metadata", () => {
	const envelope = block(
		{ id: "thinking-1", kind: "thinking", defaultDisplayMode: "expanded", currentDisplayMode: "collapsed", manualOverride: true },
		{ markdown: "one\ntwo\nthree" },
		{ defaultDisplayMode: "expanded", respectManualFolds: true },
	);
	const thinking = componentForBlock(envelope) as ThinkingBlock;
	expect(thinking.displayMode).toBe("collapsed");
	expect(thinking.manualOverride).toBe(true);
	expect(thinking.render(80)).toHaveLength(1);
});
