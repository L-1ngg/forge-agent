import { expect, test } from "bun:test";
import type { Exchange } from "../support/http-fixture.ts";
import { withScenario } from "../support/scenario.ts";
import { frames, path, protocols, settings } from "../fixtures/protocol.ts";

for (const protocol of protocols) for (const failure of [429, 503, "disconnect", "backoff-cancel"] as const) test(`${protocol}: ${failure} respects retry requests and side effects`, () => withScenario(`${protocol}/retry-${failure}`, async scenario => {
	const match = (body: unknown) => {
		const request = body as { tools: Array<{ name: string }> };
		expect(JSON.stringify(body)).toContain("retry prompt");
		expect(request.tools.some(tool => tool.name === "capture")).toBe(true);
	};
	const first: Exchange = { id: "initial-error", method: "POST", path: path(protocol), match, response: failure === "disconnect"
		? { chunks: frames(protocol, true).slice(0, 3), end: "close" }
		: { status: failure === "backoff-cancel" ? 429 : failure, headers: { "content-type": "application/json" }, chunks: [JSON.stringify({ type: "error", error: { type: failure === 503 ? "overloaded_error" : "rate_limit_error", message: failure === 503 ? "temporarily overloaded" : "rate limit exceeded" } })] } };
	const script: Exchange[] = [first];
	if (failure !== "backoff-cancel") script.push(
		{ id: "retry-tool", method: "POST", path: path(protocol), match, response: { chunks: frames(protocol, true) } },
		{ id: "continuation", method: "POST", path: path(protocol), match(body) { match(body); expect(JSON.stringify(body)).toContain("one-effect"); }, response: { chunks: frames(protocol) } },
	);
	const fixture = scenario.httpFixture(scenario.id, script);
	let effects = 0;
	const agent = await scenario.agent({ ...settings(protocol), baseUrl: fixture.url,
		retry: { enabled: true, maxRetries: 1, baseDelayMs: failure === "backoff-cancel" ? 10000 : 0 },
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "capture", label: "Capture", description: "capture", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute(args) { expect(args).toEqual({ value: "你好" }); effects++; return { content: [{ type: "text", text: "one-effect" }], details: {} }; } }],
	});
	const turn = agent.runTurn("retry prompt"); let retries = 0;
	for await (const event of turn) {
		scenario.trace.record("event", event);
		if (event.type === "retry" && event.phase === "scheduled") { retries++; expect(effects).toBe(0); if (failure === "backoff-cancel") agent.abort(); }
	}
	expect(await turn.result).toEqual({ status: failure === "backoff-cancel" ? "aborted" : "success" });
	expect(retries).toBe(1); expect(fixture.count).toBe(failure === "backoff-cancel" ? 1 : 3);
	expect(effects).toBe(failure === "backoff-cancel" ? 0 : 1);
}));
