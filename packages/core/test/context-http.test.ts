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
const user = (text: string): SessionMessage => ({ role: "user", timestamp: 1, content: [{ type: "text", text }] });
const assistant = (text: string): SessionMessage => ({ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text }] });
interface Body { system?: unknown; tools?: unknown[]; messages: unknown[]; max_tokens: number; thinking?: unknown; }
const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test-key", cwd: process.cwd(), systemPrompt: "TASK SYSTEM", thinkingLevel: "medium" as const };

function openAIResponse(chat: boolean): Response {
	if (chat) return new Response([
		{ id: "chat_summary", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "checkpoint" }, finish_reason: null }] },
		{ id: "chat_summary", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	const item = { type: "message", id: "msg_summary", role: "assistant", status: "completed", content: [{ type: "output_text", text: "checkpoint", annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: "resp_summary" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "checkpoint" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_summary", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const scenario of [
	{ provider: "anthropic", model: "claude-sonnet-4-5", reasoning: "inherit", expected: { max_tokens: 8992, thinking: { type: "enabled", budget_tokens: 7968 } } },
	{ provider: "anthropic", model: "claude-sonnet-4-6", reasoning: "inherit", expected: { max_tokens: 800, thinking: { type: "adaptive" }, output_config: { effort: "medium" } } },
	{ provider: "openai", model: "gpt-5.2", reasoning: "inherit", expected: { max_output_tokens: 800, reasoning: { effort: "medium" } } },
	{ provider: "openai", model: "gpt-5", reasoning: "off", expected: { max_output_tokens: 800, reasoning: { effort: "medium" } } },
	{ provider: "deepseek", model: "deepseek-v4-flash", reasoning: "off", expected: { max_tokens: 800, thinking: { type: "disabled" } } },
] as const) test(`HTTP summary parameter mapping: ${scenario.model}/${scenario.reasoning}`, async () => {
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json()); return scenario.provider === "anthropic" ? response("checkpoint") : openAIResponse(scenario.provider === "deepseek"); } });
	const events: SessionEvent[] = [];
	const agent = await createAgent({ ...base, provider: scenario.provider, model: scenario.model, baseUrl: server.url.toString(), sessionId: "acceptance-session", storage: new MemorySessionStorage([user("old"), assistant("work"), user("recent")]), context: { keepRecentTokens: 1, reserveTokens: 1000, summaryReasoning: scenario.reasoning }, retry: { enabled: false } });
	try {
		expect((await agent.compact(undefined, (event) => events.push(event))).status).toBe("complete");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject(scenario.expected);
		expect(requests[0]?.tools ?? []).toEqual([]);
		expect(JSON.stringify(requests[0])).not.toContain("cache_control");
		expect(requests[0]?.prompt_cache_key).toBeUndefined();
		if (scenario.model === "gpt-5") expect(events).toContainEqual(expect.objectContaining({ type: "compaction", phase: "attempt", thinking: "medium", error: expect.stringContaining("does not support") }));
	} finally { await agent.dispose(); server.stop(true); }
});

test.each([401, 403, 402])("HTTP permanent summary failure %s does not retry", async (status) => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ error: { type: "authentication_error", message: "invalid key or insufficient quota" } }, { status }); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), storage: new MemorySessionStorage([user("old"), assistant("work"), user("recent")]), context: { keepRecentTokens: 1 }, retry: { baseDelayMs: 0 } });
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

test("HTTP summary uses isolated system, off override, no cache/tools, and truncates only serialized tool text", async () => {
	const requests: Body[] = [];
	const rawToolText = "A".repeat(2000) + "OMITTED_SECRET";
	const history: SessionMessage[] = [user("original goal"), { ...assistant("work"), stopReason: "tool_use", content: [{ type: "tool_call", id: "read", name: "read", arguments: { path: "input.txt" } }] }, { role: "toolResult", timestamp: 3, toolCallId: "read", toolName: "read", content: [{ type: "text", text: rawToolText }] }, user("recent")];
	const storage = new MemorySessionStorage(history);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json() as Body); return response("checkpoint retains original goal"); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), storage, context: { keepRecentTokens: 1, reserveTokens: 1000, summaryReasoning: "off" } });
	try {
		const events: SessionEvent[] = [];
		expect((await agent.compact("preserve constraints", (event) => events.push(event))).status).toBe("complete");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.max_tokens).toBe(800);
		expect(requests[0]?.tools ?? []).toEqual([]);
		expect(requests[0]?.thinking).toEqual({ type: "disabled" });
		expect(JSON.stringify(requests[0]?.system)).not.toContain("TASK SYSTEM");
		expect(JSON.stringify(requests[0])).not.toContain("cache_control");
		expect(JSON.stringify(requests[0])).not.toContain("OMITTED_SECRET");
		expect(JSON.stringify(requests[0])).toContain("[truncated]");
		expect(JSON.stringify(await storage.load())).toContain("OMITTED_SECRET");
		expect(events.some((event) => event.type === "compaction" && event.phase === "attempt" && event.thinking === "off")).toBe(true);
	} finally { await agent.dispose(); server.stop(true); }
});

test("HTTP transient summary failures retry once at the configured layer; disabled retry makes one request", async () => {
	for (const enabled of [true, false]) {
		let requests = 0;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { if (++requests === 1) return Response.json({ error: { type: "overloaded_error", message: "503 service unavailable" } }, { status: 503 }); return response("checkpoint"); } });
		const agent = await createAgent({ ...base, thinkingLevel: "off", baseUrl: server.url.toString(), storage: new MemorySessionStorage([user("old"), assistant("work"), user("recent")]), context: { keepRecentTokens: 1 }, retry: { enabled, baseDelayMs: 0 } });
		try { expect((await agent.compact()).status).toBe(enabled ? "complete" : "error"); expect(requests).toBe(enabled ? 2 : 1); }
		finally { await agent.dispose(); server.stop(true); }
	}
});

test("HTTP partial overflow preserves the failed record and recovers to a separate final answer", async () => {
	const requests: Body[] = [];
	let taskRequests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as Body; requests.push(body);
		if (!JSON.stringify(body.system).includes("TASK SYSTEM")) return response("checkpoint");
		return ++taskRequests === 1 ? response("failed partial", true) : response("final answer");
	} });
	const storage = new MemorySessionStorage([user("original goal"), assistant("previous work")]);
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
