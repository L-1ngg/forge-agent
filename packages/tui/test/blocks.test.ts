import { expect, test } from "bun:test";
import { block } from "@myh/protocol";
import { EditBlock, ExecuteBlock, ThinkingBlock } from "../src/index.ts";

test("thinking block keeps a manual fold while streaming content changes", () => {
	const thinking = new ThinkingBlock({ markdown: "one\ntwo\nthree\nfour" });
	thinking.toggle();
	expect(thinking.displayMode).toBe("collapsed");
	thinking.setText("one\ntwo\nthree\nfour\nfive");
	expect(thinking.displayMode).toBe("collapsed");
	expect(thinking.render(80)).toHaveLength(1);
	thinking.clearManualOverride();
	expect(thinking.displayMode).toBe("truncated");
	expect(thinking.render(80).join("\n")).toContain("... 2 more lines");
});

test("execute block preserves the head and tail when truncated", () => {
	const execute = new ExecuteBlock({ command: "run", stdout: "a\nb\nc\nd\ne\nf" });
	const rendered = execute.render(80).join("\n");
	expect(rendered).toContain("$ run");
	expect(rendered).toContain("a");
	expect(rendered).toContain("b");
	expect(rendered).toContain("e");
	expect(rendered).toContain("f");
	expect(rendered).toContain("lines omitted");
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
	expect(rendered).toContain("+1/-1");
	expect(rendered).toContain("-1 old");
	expect(rendered).toContain("+1 new");
});
