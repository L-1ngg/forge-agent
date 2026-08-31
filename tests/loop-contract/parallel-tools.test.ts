import { expect, test } from "bun:test";
import { createPiTestPort } from "../../packages/core/src/index.ts";
import type { HarnessTool } from "../../packages/tools/src/index.ts";

test("pi parallel tool settlement retains every result when one tool fails", async () => {
	const tool: HarnessTool<{ fail?: boolean }, unknown> = {
		name: "settle",
		label: "Settle",
		description: "Return or fail from a scripted input.",
		parameters: {
			type: "object",
			properties: { fail: { type: "boolean" } },
			required: [],
			additionalProperties: false,
		},
		async execute(input) {
			await Bun.sleep(input.fail ? 1 : 5);
			return input.fail
				? { ok: false, error: { error_code: "IO_ERROR", message: "scripted failure", field: "fail", expected: "false", example: "false", retryable: true } }
				: { ok: true, value: "ok" };
		},
	};
	const port = createPiTestPort({
		tools: [tool as HarnessTool<object, unknown>],
		responses: [
			{
				toolCalls: [
					{ id: "ok-1", name: "settle", arguments: { fail: false } },
					{ id: "fail-1", name: "settle", arguments: { fail: true } },
					{ id: "ok-2", name: "settle", arguments: { fail: false } },
				],
				stopReason: "tool_use",
			},
			{ text: "done" },
		],
	});
	const settled: Array<{ id: string; isError: boolean }> = [];
	for await (const event of port.runTurn("parallel")) {
		if (event.type === "tool_execution_end") settled.push({ id: event.toolCallId, isError: event.isError });
	}
	expect(settled).toHaveLength(3);
	expect(settled).toContainEqual({ id: "fail-1", isError: true });
	expect(settled).toContainEqual({ id: "ok-1", isError: false });
	expect(settled).toContainEqual({ id: "ok-2", isError: false });
});
