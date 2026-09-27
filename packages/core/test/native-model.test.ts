import { expect, test } from "bun:test";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { EventType, type AdapterYieldChunk, type ModelMessage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { getCatalogModel } from "../src/model-catalog.ts";
import { providerModelOptions, resolveProviderAdapter } from "../src/model-adapter.ts";
import { ResponseCollector, toModelMessages } from "../src/model-response.ts";

const model = getCatalogModel("openai", "gpt-5.4")!;
const terminal = (finishReason: "stop" | "tool_calls" | "length" = "stop"): AdapterYieldChunk => ({ type: EventType.RUN_FINISHED, runId: "run", threadId: "thread", finishReason });
const text: AdapterYieldChunk[] = [
	{ type: EventType.TEXT_MESSAGE_START, messageId: "message", role: "assistant" },
	{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message", delta: "partial" },
	{ type: EventType.TEXT_MESSAGE_END, messageId: "message" },
];

test("a response settles only after a confirmed terminal and successful drainage", async () => {
	for (const scenario of ["missing", "late-error", "cancelled"] as const) {
		const events: SessionEvent[] = [];
		const collector = new ResponseCollector(model, event => { events.push(event); });
		for (const chunk of text) await collector.accept(chunk);
		if (scenario !== "missing") await collector.accept(terminal());
		const controller = new AbortController();
		if (scenario === "cancelled") controller.abort();
		const result = collector.finish(controller.signal, scenario === "late-error" ? new Error("body failed after terminal") : undefined);
		expect(result.stopReason).toBe(scenario === "cancelled" ? "aborted" : "error");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(events[0]).toMatchObject({ type: "message_start", message: { content: [] } });
		expect(events.filter(event => event.type === "message_delta")).toHaveLength(1);
	}
});

test("a malformed tool cannot be made valid by a permissive final input", async () => {
	const collector = new ResponseCollector(model, () => {});
	await collector.accept({ type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "write" });
	await collector.accept({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call", delta: '{"path":' });
	await expect(collector.accept({ type: "TOOL_CALL_END", toolCallId: "call", input: {} })).rejects.toThrow();
	expect(collector.finish()).toMatchObject({ stopReason: "error", content: [{ type: "tool_call", id: "call", name: "write" }] });
});

test("length and deferred responses stay distinct and never become tool_use", async () => {
	const truncated = new ResponseCollector(model, () => {});
	await truncated.accept({ type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "write" });
	await truncated.accept({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call", delta: '{"path":' });
	await truncated.accept(terminal("length"));
	expect(truncated.finish().stopReason).toBe("length");
	const deferred = new ResponseCollector(model, () => {});
	await deferred.accept({ ...terminal(), metadata: { forge: { stopReason: "deferred" } } });
	expect(deferred.finish().stopReason).toBe("deferred");
});

test("provider continuation signatures and original tool input survive history projection", async () => {
	const collector = new ResponseCollector(model, () => {});
	for (const chunk of [
		{ type: EventType.STEP_STARTED, stepId: "reason", stepName: "reason", stepType: "thinking" },
		{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "reasoning" },
		{ type: EventType.STEP_FINISHED, stepId: "reason", stepName: "reason", content: "", signature: "encrypted-signature" },
		{ type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "read", metadata: { itemId: "response-item", thoughtSignature: "gemini-signature" } },
		{ type: EventType.TOOL_CALL_ARGS, toolCallId: "call", delta: '{"path":"a"}' },
		{ type: "TOOL_CALL_END", toolCallId: "call", input: { path: "a" } },
		terminal("tool_calls"),
	] satisfies AdapterYieldChunk[]) await collector.accept(chunk);
	const saved = structuredClone(collector.finish());
	const history: SessionMessage[] = [saved, { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "source" }], details: { secretDisplayOnly: "ui" }, timestamp: 1 }];
	const projected = toModelMessages(history);
	expect(projected[0]).toMatchObject({ thinking: [{ content: "reasoning", signature: "encrypted-signature" }], toolCalls: [{ id: "call", function: { name: "read", arguments: '{"path":"a"}' }, metadata: { itemId: "response-item", thoughtSignature: "gemini-signature" } }] });
	expect(JSON.stringify(projected)).not.toContain("secretDisplayOnly");
	expect(history[0]).toEqual(saved);
	const old: SessionMessage = { role: "assistant", content: [{ type: "tool_call", id: "old", name: "read", arguments: {}, thoughtSignature: '{"forge":"openai-responses","version":1,"itemId":"legacy-item"}' }], timestamp: 0 };
	expect(toModelMessages([old])[0]?.toolCalls?.[0]?.metadata).toEqual({ itemId: "legacy-item" });
});

test("reasoning message and step lifecycles share a block while distinct messages stay separate", async () => {
	const collector = new ResponseCollector(model, () => {});
	for (const chunk of [
		{ type: EventType.REASONING_MESSAGE_START, messageId: "reason-message", role: "reasoning" },
		{ type: EventType.STEP_STARTED, stepId: "reason-step", stepName: "reason-step", stepType: "thinking" },
		{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason-message", delta: "first" },
		{ type: EventType.STEP_FINISHED, stepId: "reason-step", stepName: "reason-step", content: "first", signature: "first-signature" },
		{ type: EventType.REASONING_MESSAGE_END, messageId: "reason-message" },
		{ type: EventType.REASONING_MESSAGE_START, messageId: "custom-message", role: "reasoning" },
		{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "custom-message", delta: "second" },
		{ type: EventType.REASONING_MESSAGE_END, messageId: "custom-message" },
		terminal(),
	] satisfies AdapterYieldChunk[]) await collector.accept(chunk);
	expect(collector.finish().content).toEqual([{ type: "thinking", thinking: "first", thinkingSignature: "first-signature" }, { type: "thinking", thinking: "second" }]);
});

test("raw and AG-UI usage preserve cache accounting and provider failures retain partial text", async () => {
	for (const api of ["openai-responses", "anthropic-messages"] as const) {
		const collector = new ResponseCollector({ ...model, api }, () => {});
		for (const chunk of text) await collector.accept(chunk);
		await collector.accept({ type: EventType.RUN_ERROR, code: "503", message: "unavailable", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, promptTokensDetails: { cachedTokens: 30, cacheWriteTokens: 10 } } });
		expect(collector.finish()).toMatchObject({ stopReason: "error", errorMessage: "503: unavailable", usage: { input: api === "anthropic-messages" ? 100 : 60, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: api === "anthropic-messages" ? 160 : 120 } });
	}
	const collector = new ResponseCollector(model, () => {});
	await collector.accept({ type: EventType.RUN_FINISHED, runId: "run", threadId: "thread", metadata: { tanstack: { finishReason: "stop" } }, usage: [{ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 30, cacheWriteInputTokens: 10 }] });
	expect(collector.finish().usage).toMatchObject({ input: 60, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 120 });
});

test("host adapters preserve explicit costs and distinguish absent usage from absent cost", async () => {
	const absent = new ResponseCollector(model, () => {}, { calculateCost: false });
	await absent.accept(terminal());
	expect(absent.finish().usage).toBeUndefined();
	for (const cost of [undefined, 0, 0.02]) {
		const collector = new ResponseCollector(model, () => {}, { calculateCost: false });
		await collector.accept({ ...terminal(), usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20, ...(cost !== undefined ? { cost } : {}) } });
		expect(collector.finish().usage).toMatchObject({ input: 15, output: 5, totalTokens: 20 });
		expect(collector.message.usage?.cost?.total).toBe(cost);
	}
});

test("opaque text continuation metadata survives model history projection", () => {
	const projected = toModelMessages([{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "prior answer", textSignature: "opaque-text" }] }]);
	expect(projected[0]?.content).toEqual([{ type: "text", content: "prior answer", metadata: { forge: { textSignature: "opaque-text" } } }]);
});

test("native provider factory sends Responses and Chat Completions through their declared APIs", async () => {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const path = new URL(request.url).pathname;
		requests.push({ path, body: await request.json() });
		const events = path.endsWith("/responses")
			? [{ type: "response.created", response: { id: "response", model: "gpt-5.4", status: "in_progress" } }, { type: "response.completed", response: { id: "response", model: "gpt-5.4", status: "completed", output: [{ type: "message", id: "answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }]
			: [{ id: "completion", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }, { id: "completion", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }];
		return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	} });
	try {
		for (const catalog of [model, getCatalogModel("deepseek", "deepseek-v4-flash")!]) {
			const selected = { ...catalog, baseUrl: server.url.toString() };
			const settings = { signal: new AbortController().signal, apiKey: "fixture-key", maxTokens: 100 };
			const native = await resolveProviderAdapter(selected, settings);
			const collector = new ResponseCollector(selected, () => {});
			for await (const chunk of native.chatStream({ model: native.model, messages: [{ role: "user", content: "hello" }], modelOptions: providerModelOptions(selected, settings), request: { signal: settings.signal }, logger: resolveDebugOption(false) })) await collector.accept(chunk);
			expect(collector.finish()).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 5, output: 2 } });
		}
		expect(requests.map(request => request.path)).toEqual(["/responses", "/chat/completions"]);
		expect(requests[0]?.body).toMatchObject({ model: "gpt-5.4", max_output_tokens: 100, store: false });
		expect(requests[1]?.body).toMatchObject({ model: "deepseek-v4-flash", max_tokens: 100 });
	} finally { server.stop(true); }
});

test("Gemini transport performs one HTTP attempt so session retry remains the sole owner", async () => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ error: { code: 503, message: "fixture unavailable", status: "UNAVAILABLE" } }, { status: 503, headers: { "retry-after": "0" } }); } });
	try {
		const selected = { ...getCatalogModel("google", "gemini-2.5-flash")!, baseUrl: server.url.toString() };
		const settings = { signal: AbortSignal.timeout(2500), apiKey: "fixture-key", maxTokens: 100 };
		const native = await resolveProviderAdapter(selected, settings);
		const collector = new ResponseCollector(selected, () => {});
		let error: unknown;
		try {
			for await (const chunk of native.chatStream({ model: native.model, messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[], modelOptions: providerModelOptions(selected, settings), request: { signal: settings.signal }, logger: resolveDebugOption(false) })) await collector.accept(chunk);
		} catch (caught) { error = caught; }
		expect(collector.finish(undefined, error).stopReason).toBe("error");
		expect(requests).toBe(1);
	} finally { server.stop(true); }
});
