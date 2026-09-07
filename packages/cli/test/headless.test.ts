import { expect, test } from "bun:test";
import { runHeadless } from "../src/headless.ts";
import { createPiTestPort } from "../../core/src/pi-port.ts";

test.each(["stop", "error", "aborted", "length"] as const)("headless uses the outcome after context recovery: %s", async (stopReason) => {
	const lines: string[] = [];
	const exitCode = await runHeadless({ async *runTurn() {
		yield { type: "turn_end", stopReason: "error", timestamp: 1 };
		yield { type: "recovery", reason: "overflow", operationId: "recovery", attempt: 1, timestamp: 2 };
		yield { type: "turn_end", stopReason, timestamp: 3 };
		yield { type: "agent_end", timestamp: 4 };
	} }, "continue", (line) => lines.push(line));
	expect(exitCode).toBe(stopReason === "stop" ? 0 : stopReason === "aborted" ? 130 : 1);
	expect(lines).toHaveLength(4);
});

test("headless emits one valid JSON object per event", async () => {
	const lines: string[] = [];
	await runHeadless({
		runTurn: async function* () {
			yield { type: "agent_start", timestamp: 1 };
			yield { type: "agent_end", timestamp: 2 };
		},
	}, "hello", (line) => lines.push(line));
	expect(lines.map((line) => JSON.parse(line))).toEqual([
		{ type: "agent_start", timestamp: 1 },
		{ type: "agent_end", timestamp: 2 },
	]);
});

test("headless reports a provider error as failure even when pi ends normally", async () => {
	const port = createPiTestPort({ responses: [{ stopReason: "error", errorMessage: "provider unavailable" }] });
	const lines: string[] = [];
	expect(await runHeadless(port, "hello", (line) => lines.push(line))).toBe(1);
	expect(lines.some((line) => JSON.parse(line).message?.errorMessage === "provider unavailable")).toBe(true);
});
