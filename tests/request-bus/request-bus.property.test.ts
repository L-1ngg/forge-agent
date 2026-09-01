import fc from "fast-check";
import { expect, test } from "bun:test";
import { RequestBus } from "../../packages/core/src/index.ts";
import { response } from "../../packages/protocol/src/index.ts";

const payload = {
	toolCall: { type: "tool_call" as const, id: "call", name: "read", arguments: { path: "file.txt" } },
};

const actionArbitrary = fc.record({
	op: fc.constantFrom("respond", "respond_again", "cancel", "unknown"),
	index: fc.integer({ min: 0, max: 2 }),
});

test("request bus terminal outcomes are absorbing under arbitrary late input", async () => {
	await fc.assert(
		fc.asyncProperty(fc.array(actionArbitrary, { maxLength: 24 }), async (actions) => {
			const bus = new RequestBus({
				idPrefix: "property",
				timeoutMs: 60_000,
				idFactory: (sequence, prefix) => `${prefix}-${sequence}`,
			});
			const promises = [0, 1, 2].map((index) => bus.ask("permission", { ...payload, toolCall: { ...payload.toolCall, id: `call-${index}` } }));
			const requestIterator = bus.requests()[Symbol.asyncIterator]();
			const ids: string[] = [];
			for (let index = 0; index < promises.length; index++) {
				const next = await requestIterator.next();
				if (next.done) throw new Error("request stream closed before all requests were emitted");
				ids.push(next.value.id);
			}

			for (const action of actions) {
				const requestId = ids[action.index];
				if (!requestId) continue;
				switch (action.op) {
					case "respond":
						bus.respond(response(requestId, { decision: "allow_once" }));
						break;
					case "respond_again":
						bus.respond(response(requestId, { decision: "deny" }));
						break;
					case "cancel":
						bus.cancel(requestId);
						break;
					case "unknown":
						bus.respond(response(`unknown-${action.index}`, { decision: "deny" }));
						break;
				}
			}

			bus.abort();
			const outcomes = await Promise.all(promises);
			expect(outcomes).toHaveLength(3);
			expect(new Set(outcomes.map((outcome) => outcome.requestId)).size).toBe(3);
			for (const outcome of outcomes) {
				expect(bus.getTerminal(outcome.requestId)).toEqual(outcome);
				const snapshot = bus.getTerminal(outcome.requestId);
				bus.cancel(outcome.requestId);
				expect(bus.respond(response(outcome.requestId, { decision: "allow_once" }))).toBe(false);
				expect(bus.getTerminal(outcome.requestId)).toEqual(snapshot);
			}
			expect(bus.pendingCount).toBe(0);
			bus.close();
		}),
		{ numRuns: 500 },
	);
});
