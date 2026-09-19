import { scriptedTurn } from "../../../tests/support/turn.ts";
import type { SessionEvent } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import { runHeadless } from "../src/headless.ts";
import { createAgent } from "../../core/src/agent.ts";
import { createPiTestPort } from "../../core/src/pi-port.ts";

test.each([ ["success", 0], ["deferred", 0], ["error", 1], ["length", 1], ["aborted", 130] ] as const)("headless uses settled %s even when events disagree", async (status, expected) => {
	const lines: string[] = [];
	const port = { runTurn() { return {
		result: Promise.resolve({ status }),
		async *[Symbol.asyncIterator](): AsyncGenerator<SessionEvent> {
			yield { type: "agent_end", outcome: "success", timestamp: 1 };
		},
	}; } };
	expect(await runHeadless(port, "hello", line => lines.push(line))).toBe(expected);
	expect(JSON.parse(lines[0]!).outcome).toBe("success");
});

test.each(["stop", "error", "aborted", "length"] as const)("headless uses the outcome after context recovery: %s", async (stopReason) => {
	const lines: string[] = [];
	const exitCode = await runHeadless({ runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
		yield { type: "turn_end", stopReason: "error", timestamp: 1 };
		yield { type: "recovery", reason: "overflow", operationId: "recovery", attempt: 1, timestamp: 2 };
		yield { type: "turn_end", stopReason, timestamp: 3 };
		yield { type: "agent_end", timestamp: 4 };
	})(), { status: stopReason === "stop" ? "success" : stopReason }); } }, "continue", (line) => lines.push(line));
	expect(exitCode).toBe(stopReason === "stop" ? 0 : stopReason === "aborted" ? 130 : 1);
	expect(lines).toHaveLength(4);
});

test("headless emits one valid JSON object per event", async () => {
	const lines: string[] = [];
	await runHeadless({
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "agent_start", timestamp: 1 };
			yield { type: "agent_end", timestamp: 2 };
		})()); },
	}, "hello", (line) => lines.push(line));
	expect(lines.map((line) => JSON.parse(line))).toEqual([
		{ type: "agent_start", timestamp: 1 },
		{ type: "agent_end", timestamp: 2 },
	]);
});

test("headless reports a provider error as failure even when pi ends normally", async () => {
	const port = await createAgent({ provider: "faux", model: "faux-1", cwd: process.cwd(), systemPrompt: "test" }, () => createPiTestPort({ responses: [{ stopReason: "error", errorMessage: "provider unavailable" }] }));
	const lines: string[] = [];
	try { expect(await runHeadless(port, "hello", (line) => lines.push(line))).toBe(1); }
	finally { await port.dispose(); }
	expect(lines.some((line) => JSON.parse(line).message?.errorMessage === "provider unavailable")).toBe(true);
});
