import { expect, test } from "bun:test";
import { block, type BlockEnvelope } from "@forge-agent/protocol";
import { bashTool, editTool } from "@forge-agent/tools";
import { createEditBlockData, createPiTestPort, digest } from "../src/index.ts";

test("core computes line hunks and aggregate edit counts", () => {
	const data = createEditBlockData("src/demo.ts", "keep\nold\n", "keep\nnew\nadded\n");
	expect(data.path).toBe("src/demo.ts");
	expect(data.additions).toBe(2);
	expect(data.removals).toBe(1);
	expect(data.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, additions: 2, removals: 1 });
	expect(data.hunks[0]?.lines).toEqual([
		{ type: "context", content: "keep", oldLine: 1, newLine: 1 },
		{ type: "remove", content: "old", oldLine: 2 },
		{ type: "add", content: "new", newLine: 2 },
		{ type: "add", content: "added", newLine: 3 },
	]);
});

test("core ignores diff's no-newline diagnostic instead of shifting hunk line numbers", () => {
	const data = createEditBlockData("src/demo.ts", "first\nold", "first\nnew\nadded");

	expect(data.hunks).toHaveLength(1);
	expect(data.hunks[0]?.lines).toEqual([
		{ type: "context", content: "first", oldLine: 1, newLine: 1 },
		{ type: "remove", content: "old", oldLine: 2 },
		{ type: "add", content: "new", newLine: 2 },
		{ type: "add", content: "added", newLine: 3 },
	]);
	expect(data.hunks[0]?.lines.some((line) => line.content.includes("No newline"))).toBe(false);
});

test("digest strips terminal sequences, has a hard limit, and is stable", () => {
	const value: BlockEnvelope<"execute"> = block(
		{ id: "exec-1", kind: "execute", lifecycle: "complete" },
		{ command: "echo ok", stdout: "\u001b[31mfirst\u001b[0m\nsecond" },
	);
	const first = digest(value, { maxLength: 20 });
	expect(first).not.toContain("\u001b[");
	expect(first.length).toBeLessThanOrEqual(20);
	expect(digest(first, { maxLength: 20 })).toBe(first);
	expect(digest(value, { maxLength: 20 })).toBe(first);
});

test("digest omits a trailing placeholder for short values", () => {
	expect(digest("  one\n two  ", { maxLength: 100 })).toBe("one two");
});

test("execute block keeps its original command when a failed result has no details", async () => {
	const port = createPiTestPort({
		tools: [bashTool],
		responses: [{ stopReason: "stop", toolCalls: [{ id: "failed-exec", name: "bash", arguments: { command: "false" } }] }],
	});
	const events = [];
	for await (const event of port.runTurn("run command")) events.push(event);
	const end = events.find((event) => event.type === "tool_execution_end");
	expect(end?.block).toMatchObject({ kind: "execute", lifecycle: "failed", data: { command: "false" } });
});

test("edit execution ends with a terminal block for both success and failure", async () => {
	for (const fails of [false, true]) {
		const port = createPiTestPort({
			tools: [{ ...editTool, async execute() {
				if (fails) throw new Error("edit failed");
				return { ok: true, value: { path: "file", replacements: 1 } };
			} }],
			responses: [{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "file", old_text: "old", new_text: "new" } }] }, { text: "done" }],
		});
		const events = [];
		for await (const event of port.runTurn("edit")) events.push(event);
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end?.block).toMatchObject({ kind: "edit", lifecycle: fails ? "failed" : "complete", data: { path: "file", additions: 1, removals: 1 } });
	}
});
