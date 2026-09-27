import { createTestAgent } from "../support/test-agent.ts";
import { expect, test } from "bun:test";
import type { HarnessTool } from "../../packages/tools/src/index.ts";

test("native agent drains steering after the active tool turn", async () => {
	const tool: HarnessTool<object, unknown> = {
		name: "hold",
		label: "Hold",
		description: "Wait briefly.",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		async execute() {
			await Bun.sleep(5);
			return { content: [{ type: "text", text: "done" }], details: "done" };
		},
	};
	const port = await createTestAgent({
		permission: { rules: [{ tool: "hold", argsPattern: "*", effect: "allow" }] },
		tools: [tool],
		responses: [
			{ toolCalls: [{ id: "hold-1", name: "hold", arguments: {} }], stopReason: "tool_use" },
			{ echoLastUser: true },
		],
	});
	let steered = false;
	let finalText = "";
	const turn = port.runTurn("initial");
	for await (const event of turn) {
		if (event.type === "tool_execution_start" && !steered) {
			steered = true;
			expect(port.steer("steer-message", turn.id).accepted).toBe(true);
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			finalText = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		}
	}
	expect(steered).toBe(true);
	expect(finalText).toBe("steer-message");
});
