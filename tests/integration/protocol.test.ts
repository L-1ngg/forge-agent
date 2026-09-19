import { expect, test } from "bun:test";
import type { Exchange } from "../support/http-fixture.ts";
import { withScenario } from "../support/scenario.ts";
import { bytes, frames, failedFrames, path, protocols, settings, type Protocol } from "../fixtures/protocol.ts";
import { matchProtocolRequest } from "../fixtures/protocol-request.ts";

const parameters = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false as const };
function exchange(protocol: Protocol, id: string, chunks: Exchange["response"]["chunks"], continuation = false): Exchange {
	return { id, method: "POST", path: path(protocol), match: matchProtocolRequest(protocol, continuation), response: { chunks } };
}

for (const protocol of protocols) {
	test(`${protocol}: default SDK decodes fragmented UTF-8/SSE and tool deltas through continuation`, () => withScenario(`${protocol}/tool-loop`, async scenario => {
		const fixture = scenario.httpFixture(scenario.id, [exchange(protocol, "tool", bytes(frames(protocol, true).join(""))), exchange(protocol, "answer", bytes(frames(protocol).join("")), true)]);
		const effects: unknown[] = [];
		const agent = await scenario.agent({ ...settings(protocol), baseUrl: fixture.url,
			permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
			tools: [{ name: "capture", label: "Capture", description: "capture", parameters, async execute(args) { effects.push(args); scenario.trace.record("tool", args); return { content: [{ type: "text", text: "captured:你好" }], details: {} }; } }],
		});
		const turn = agent.runTurn("protocol prompt"); const events = await scenario.collect(turn);
		expect(effects).toEqual([{ value: "你好" }]);
		expect(await turn.result).toEqual({ status: "success" });
		expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant").at(-1)).toMatchObject({ message: { content: [{ type: "text", text: "你好🌍" }], stopReason: "stop" } });
	}));

	for (const failure of ["truncated-json", "error-terminal", "cancel"] as const) test(`${protocol}: ${failure} cannot execute partial tools`, () => withScenario(`${protocol}/${failure}`, async scenario => {
		let effects = 0;
		const prefix = frames(protocol, true).slice(0, 3);
		const chunks = failure === "error-terminal" ? failedFrames(protocol) : failure === "truncated-json" ? [...prefix, 'data: {"type":'] : prefix;
		const step = exchange(protocol, failure, bytes(chunks.join("")));
		if (failure === "cancel") step.response.end = "hold";
		const fixture = scenario.httpFixture(scenario.id, [step]);
		const agent = await scenario.agent({ ...settings(protocol), baseUrl: fixture.url,
			permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
			tools: [{ name: "capture", label: "Capture", description: "capture", parameters, async execute() { effects++; return { content: [], details: {} }; } }],
		});
		const turn = agent.runTurn("protocol prompt");
		let canceled = false;
		for await (const event of turn) {
			scenario.trace.record("event", event);
			if (failure === "cancel" && event.type === "message_delta" && event.contentType === "tool_call") { canceled = true; agent.abort(); }
		}
		expect(effects).toBe(0);
		expect(await turn.result).toEqual({ status: failure === "cancel" ? "aborted" : "error" });
		if (failure === "cancel") expect(canceled).toBe(true);
		expect((await scenario.storage.load()).entries.length).toBeGreaterThanOrEqual(2);
	}));
}
