import { expect, test } from "bun:test";
import { createPiTestPort } from "../../packages/core/src/index.ts";

const stopReasons = ["stop", "length", "tool_use", "error", "aborted", "deferred"] as const;
type StopReason = (typeof stopReasons)[number];

function nextAction(reason: StopReason): "idle" | "continue" | "retry" | "report" {
	if (reason === "tool_use") return "continue";
	if (reason === "error") return "retry";
	if (reason === "aborted") return "report";
	if (reason === "deferred") return "report";
	return "idle";
}

test("pi exposes every stop reason with an explicit follow-up action", async () => {
	const observed = new Map<StopReason, ReturnType<typeof nextAction>>();
	for (const reason of stopReasons) {
		const port = createPiTestPort({
			responses: [{ text: reason, stopReason: reason, ...(reason === "error" ? { errorMessage: "scripted error" } : {}) }],
		});
		for await (const event of port.runTurn(reason)) {
			if (event.type === "turn_end" && event.stopReason) observed.set(event.stopReason, nextAction(event.stopReason));
		}
	}
	const actions = observed;
	expect(actions.size).toBe(6);
	expect(actions.get("stop")).toBe("idle");
	expect(actions.get("length")).toBe("idle");
	expect(actions.get("tool_use")).toBe("continue");
	expect(actions.get("error")).toBe("retry");
	expect(actions.get("aborted")).toBe("report");
	expect(actions.get("deferred")).toBe("report");
});
