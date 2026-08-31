import { expect, test } from "bun:test";
import { createPiTestPort } from "../../packages/core/src/index.ts";
import type { HarnessTool } from "../../packages/tools/src/index.ts";

test("pi drains steering after the active tool turn", async () => {
	const tool: HarnessTool<object, unknown> = {
		name: "hold",
		label: "Hold",
		description: "Wait briefly.",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		async execute() {
			await Bun.sleep(5);
			return { ok: true, value: "done" };
		},
	};
	const port = createPiTestPort({
		tools: [tool],
		responses: [
			{ toolCalls: [{ id: "hold-1", name: "hold", arguments: {} }], stopReason: "tool_use" },
			{ echoLastUser: true },
		],
	});
	let steered = false;
	let finalText = "";
	for await (const event of port.runTurn("initial")) {
		if (event.type === "tool_execution_start" && !steered) {
			steered = true;
			port.steer("steer-message");
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			finalText = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		}
	}
	expect(steered).toBe(true);
	expect(finalText).toBe("steer-message");
});
