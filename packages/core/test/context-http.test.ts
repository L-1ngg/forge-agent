import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage } from "@forge-agent/core/sdk";
import type { SessionMessage, SessionEvent } from "@forge-agent/protocol";

function response(text: string, partialError = false): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_context", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text } },
		{ type: "content_block_stop", index: 0 },
		...(partialError ? [{ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 200001 tokens > 200000 maximum" } }] : [
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		]),
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const checkpoint = JSON.stringify({ states: [], claims: [], taskChanged: false });
const user = (text: string): SessionMessage => ({ role: "user", timestamp: 1, content: [{ type: "text", text }] });
const assistant = (text: string): SessionMessage => ({ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text }] });
interface Body { system?: unknown; tools?: unknown[]; messages: unknown[]; max_tokens: number; thinking?: unknown; }
const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test-key", cwd: process.cwd(), systemPrompt: "TASK SYSTEM", thinkingLevel: "medium" as const };

function openAIResponse(chat: boolean): Response {
	if (chat) return new Response([
		{ id: "chat_summary", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: checkpoint }, finish_reason: null }] },
		{ id: "chat_summary", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	const item = { type: "message", id: "msg_summary", role: "assistant", status: "completed", content: [{ type: "output_text", text: checkpoint, annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: "resp_summary" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: checkpoint },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_summary", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const scenario of [
	{ provider: "anthropic", model: "claude-sonnet-4-5", reasoning: "inherit", expected: { max_tokens: 12288, thinking: { type: "enabled", budget_tokens: 8192 } } },
	{ provider: "anthropic", model: "claude-sonnet-4-6", reasoning: "inherit", expected: { max_tokens: 4096, thinking: { type: "adaptive" }, output_config: { effort: "medium" } } },
	{ provider: "openai", model: "gpt-5.2", reasoning: "inherit", expected: { max_output_tokens: 4096, reasoning: { effort: "medium" } } },
	{ provider: "openai", model: "gpt-5", reasoning: "off", expected: { max_output_tokens: 4096, reasoning: { effort: "medium" } } },
	{ provider: "deepseek", model: "deepseek-v4-flash", reasoning: "off", expected: { max_tokens: 4096, thinking: { type: "disabled" } } },
] as const) test(`HTTP summary parameter mapping: ${scenario.model}/${scenario.reasoning}`, async () => {
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json()); return scenario.provider === "anthropic" ? response(checkpoint) : openAIResponse(scenario.provider === "deepseek"); } });
	const events: SessionEvent[] = [];
	const agent = await createAgent({ ...base, provider: scenario.provider, model: scenario.model, baseUrl: server.url.toString(), sessionId: "acceptance-session", storage: new MemorySessionStorage([user("old"), assistant("work ".repeat(1500)), user("recent")]), context: { keepRecentTokens: 1, reserveTokens: 1000, summaryReasoning: scenario.reasoning }, retry: { enabled: false } });
	try {
		expect((await agent.compact(undefined, (event) => events.push(event))).status).toBe("complete");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject(scenario.expected);
		expect(requests[0]?.tools ?? []).toEqual([]);
		expect(JSON.stringify(requests[0])).not.toContain("cache_control");
		expect(requests[0]?.prompt_cache_key).toBeUndefined();
	} finally { await agent.dispose(); server.stop(true); }
});

test.each([401, 403, 402])("HTTP permanent summary failure %s never retries or rebuilds", async (status) => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ error: { type: "authentication_error", message: "invalid key or insufficient quota" } }, { status }); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), storage: new MemorySessionStorage([user("old"), assistant("work ".repeat(1500)), user("recent")]), context: { keepRecentTokens: 1 }, retry: { baseDelayMs: 0 } });
	try { expect((await agent.compact()).status).toBe("error"); expect(requests).toBe(1); }
	finally { await agent.dispose(); server.stop(true); }
});

test("SDK replays image bytes through the real HTTP adapter and estimates them on reopen", async () => {
	const requests: Body[] = [];
	const storage = new MemorySessionStorage([{ role: "user", timestamp: 1, content: [{ type: "text", text: "describe image" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }]);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json() as Body); return response("image received"); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), storage, context: { enabled: false } });
	try {
		expect(agent.getUsage()?.contextTokens).toBeGreaterThan(1024);
		for await (const _event of agent.runTurn("continue")) {}
		expect(JSON.stringify(requests[0])).toContain('"type":"base64","media_type":"image/png","data":"aW1hZ2U="');
		expect(JSON.stringify(await storage.load())).toContain("aW1hZ2U=");
	} finally { await agent.dispose(); server.stop(true); }
});


test("HTTP transient summary errors obey retry settings without checkpoint rebuild", async () => {
	for (const enabled of [true, false]) {
		let requests = 0;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { if (++requests === 1) return Response.json({ error: { type: "overloaded_error", message: "503 service unavailable" } }, { status: 503 }); return response(checkpoint); } });
		const agent = await createAgent({ ...base, thinkingLevel: "off", baseUrl: server.url.toString(), storage: new MemorySessionStorage([user("old"), assistant("work ".repeat(1500)), user("recent")]), context: { keepRecentTokens: 1 }, retry: { enabled, baseDelayMs: 0 } });
		try {
			const events: SessionEvent[] = [];
			expect((await agent.compact(undefined, event => events.push(event))).status).toBe(enabled ? "complete" : "error");
			expect(requests).toBe(enabled ? 2 : 1);
			expect(events.at(-1)).toMatchObject({ phase: enabled ? "end" : "error", modelCalls: enabled ? 2 : 1, generations: 1 });
		}
		finally { await agent.dispose(); server.stop(true); }
	}
});

test("HTTP partial overflow preserves the failed record and recovers to a separate final answer", async () => {
	const requests: Body[] = [];
	let taskRequests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as Body; requests.push(body);
		if (!JSON.stringify(body.system).includes("TASK SYSTEM")) return response(checkpoint);
		return ++taskRequests === 1 ? response("failed partial", true) : response("final answer");
	} });
	const storage = new MemorySessionStorage([user("original goal"), assistant("previous work ".repeat(1500))]);
	const agent = await createAgent({ ...base, thinkingLevel: "off", baseUrl: server.url.toString(), storage, context: { keepRecentTokens: 1 } });
	try {
		const events: SessionEvent[] = [];
		for await (const event of agent.runTurn("continue")) events.push(event);
		expect(taskRequests).toBe(2);
		expect(events.filter((event) => event.type === "recovery")).toHaveLength(1);
		expect(JSON.stringify(requests.at(-1))).not.toContain("failed partial");
		expect(JSON.stringify(await storage.load())).toContain("failed partial");
		expect(JSON.stringify(events)).toContain("final answer");
	} finally { await agent.dispose(); server.stop(true); }
});

// The helper-only counterexample must also hold at the production HTTP boundary.
for (const thinking of ["off", "medium"] as const) test(`host final gate prevents builtin output clamping: ${thinking}`, async () => {
	const { withScenario } = await import("../../../tests/support/scenario.ts");
	const { modelResponse } = await import("./helpers/model-response.ts");
	await withScenario(`builtin-clamp-${thinking}`, async s => {
		const body = await modelResponse().text();
		const expectedOutput = thinking === "off" ? 1024 : 9216;
		const fixture = s.httpFixture("only-control-request", [{ id: "control", method: "POST", path: "/v1/messages", match(body) {
			expect(body).toMatchObject({ max_tokens: expectedOutput });
			if (thinking === "medium") expect(body).toMatchObject({ thinking: { type: "enabled", budget_tokens: 8192 } });
		}, response: { chunks: [body] } }]);
		let callbacks = 0;
		const agent = await s.agent({ ...base, baseUrl: fixture.url, thinkingLevel: thinking, maxTokens: 1024, context: { enabled: false }, transformContext: context => {
			if (++callbacks > 1) return context.messages;
			const input = context.model.contextWindow - context.budget.effectiveOutputTokens - 2000;
			expect(input).toBeLessThan(context.budget.maxInputTokens);
			return [user("x".repeat((input - context.budget.fixedTokens - 1) * 4))];
		} });
		const rejected = agent.runTurn("too close to provider limit"); const events = await s.collect(rejected);
		expect((await rejected.result).status).toBe("error"); expect(JSON.stringify(events)).toContain("builtin-output-clamp"); expect(fixture.count).toBe(0);
		const control = agent.runTurn("short control"); await s.collect(control); expect((await control.result).status).toBe("success"); expect(fixture.count).toBe(1);
	});
});

test("switching custom and builtin streams commits the preflight policy atomically", async () => {
	const { withScenario } = await import("../../../tests/support/scenario.ts");
	const { fauxModel } = await import("../../../tests/support/model.ts");
	await withScenario("transport-switch", async s => {
		const fixture = s.httpFixture("no-http", []); let customCalls = 0;
		const custom = fauxModel({ responses: [{ text: "custom one" }, { text: "custom two" }] });
		const streamFn: import("../src/sdk.ts").StreamFn = (model, context, options) => { customCalls++; return custom.streamFn(custom.model, context, options); };
		const agent = await s.agent({ ...base, thinkingLevel: "off", maxTokens: 1024, baseUrl: fixture.url, streamFn, context: { enabled: false }, transformContext: context => {
			const input = context.model.contextWindow - context.budget.effectiveOutputTokens - 2000;
			return [user("x".repeat((input - context.budget.fixedTokens - 1) * 4))];
		} });
		const first = agent.runTurn("custom"); await s.collect(first); expect((await first.result).status).toBe("success");
		await (await agent.updateConfiguration({ streamFn: null })).applied;
		const second = agent.runTurn("builtin"); await s.collect(second); expect((await second.result).status).toBe("error"); expect(fixture.count).toBe(0);
		await (await agent.updateConfiguration({ streamFn })).applied;
		const third = agent.runTurn("custom again"); await s.collect(third); expect((await third.result).status).toBe("success"); expect(customCalls).toBe(2);
	});
});

test("builtin request ignores stale historical usage and respects a smaller local window", async () => {
	const { withScenario } = await import("../../../tests/support/scenario.ts");
	const { modelResponse } = await import("./helpers/model-response.ts");
	await withScenario("stale-usage-http", async s => {
		const body = await modelResponse().text();
		const fixture = s.httpFixture("one-request", [{ id: "short", method: "POST", path: "/v1/messages", match(body) { expect(body).toMatchObject({ max_tokens: 1024 }); }, response: { chunks: [body] } }]);
		const old: SessionMessage = { ...assistant("old"), usage: { input: 10000000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 10000100 } };
		const storage = new MemorySessionStorage([user("old"), old]);
		let calls = 0;
		const agent = await s.agent({ ...base, baseUrl: fixture.url, thinkingLevel: "off", contextWindow: 16000, maxTokens: 1024, storage, context: { enabled: false }, transformContext: context => ++calls === 1 ? context.messages : [user("x".repeat(64000))] });
		const control = agent.runTurn("short"); await s.collect(control); expect((await control.result).status).toBe("success");
		const rejected = agent.runTurn("local limit"); const events = await s.collect(rejected); expect((await rejected.result).status).toBe("error"); expect(JSON.stringify(events)).toContain("request-budget (general)"); expect(fixture.count).toBe(1);
		expect(JSON.stringify(await storage.load())).toContain("10000100");
	});
});
