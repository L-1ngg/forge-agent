import { expect, test } from "bun:test";
import fc from "fast-check";
import { createPiTestPort } from "../../packages/core/src/index.ts";
import { initialAbortState, runAbortMachine, stepAbortMachine, type AbortInput } from "./abort-machine.ts";

const eventArbitrary: fc.Arbitrary<AbortInput> = fc.oneof(
	fc.constant({ type: "turn_start" } as const),
	fc.stringMatching(/^[a-z0-9]{1,4}$/).map((id) => ({ type: "tool_call", id }) as const),
	fc.stringMatching(/^[a-z0-9]{1,4}$/).map((id) => ({ type: "tool_result", id }) as const),
	fc.constant({ type: "assistant_message" } as const),
	fc.constant({ type: "abort" } as const),
	fc.constant({ type: "turn_end" } as const),
);

test("abort state machine preserves tool pairing, atomic abort, and terminal states", () => {
	fc.assert(
		fc.property(fc.array(eventArbitrary, { maxLength: 100 }), (inputs) => {
			let state = initialAbortState();
			for (const input of inputs) {
				const previous = state;
				state = stepAbortMachine(state, input);
				if (previous.status === "aborted" || previous.status === "completed") expect(state).toEqual(previous);
			}
			if (state.status === "aborted") {
				expect(state.openToolCalls.size).toBe(0);
			}
			for (const id of state.completedToolCalls) expect(state.openToolCalls.has(id)).toBe(false);
			if (state.status === "completed") expect(state.openToolCalls.size).toBe(0);
			expect(state.completedToolCalls.size).toBeLessThanOrEqual(state.turnMessages);
		}),
		{ numRuns: 500 },
	);
});

test("terminal abort ignores every later input", () => {
	const before = runAbortMachine([{ type: "turn_start" }, { type: "abort" }]);
	const after = runAbortMachine([{ type: "turn_start" }, { type: "abort" }, { type: "tool_call", id: "late" }, { type: "tool_result", id: "late" }, { type: "turn_end" }]);
	expect(after).toEqual(before);
	expect(initialAbortState().status).toBe("idle");
});

test("pi port terminates a streamed turn with aborted then agent_end", async () => {
	const port = createPiTestPort({
		responses: [{ text: "abcdefghijklmnopqrstuvwxyz" }],
		tokensPerSecond: 20,
	});
	const eventTypes: string[] = [];
	let stopReason: string | undefined;
	let requestedAbort = false;
	for await (const event of port.runTurn("abort")) {
		eventTypes.push(event.type);
		if (event.type === "message_delta" && !requestedAbort) {
			requestedAbort = true;
			port.abort();
		}
		if (event.type === "turn_end") stopReason = event.stopReason;
	}
	expect(requestedAbort).toBe(true);
	expect(stopReason).toBe("aborted");
	expect(eventTypes.at(-1)).toBe("agent_end");
});
