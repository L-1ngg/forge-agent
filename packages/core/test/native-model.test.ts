import { expect, test } from "bun:test";
import type { SessionMessage } from "@forge-agent/protocol";
import { EventType, type AdapterYieldChunk } from "@tanstack/ai";
import { getCatalogModel } from "../src/model-catalog.ts";
import { toModelMessages } from "../src/model-response.ts";
import { collectResponse, nativeRequest } from "../../../tests/fixtures/native-request.ts";

const model = getCatalogModel("openai", "gpt-5.4")!;
const terminal = (finishReason: "stop" | "tool_calls" | "length" = "stop"): AdapterYieldChunk => ({ type: EventType.RUN_FINISHED, runId: "run", threadId: "thread", finishReason });
const text: AdapterYieldChunk[] = [
	{ type: EventType.TEXT_MESSAGE_START, messageId: "message", role: "assistant" },
	{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message", delta: "partial" },
	{ type: EventType.TEXT_MESSAGE_END, messageId: "message" },
];
const stream = (...chunks: AdapterYieldChunk[]) => (async function* () { yield* chunks; })();

test("summary chat rejects missing or late-failed protocol terminals and keeps partial text", async () => {
	for (const scenario of ["missing", "late-error"] as const) {
		const chunks = async function* () {
			yield* text;
			if (scenario === "late-error") { yield terminal(); throw new Error("body failed after terminal"); }
		};
		const result = await collectResponse(model, chunks());
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	}
});

test("late adapter failure overrides a truncation terminal", async () => {
	const result = await collectResponse(model, (async function* () {
		yield* text;
		yield { type: EventType.RUN_ERROR, code: "max_tokens", message: "max_output_tokens" } satisfies AdapterYieldChunk;
		throw new Error("body failed after truncation");
	})());
	expect(result).toMatchObject({ stopReason: "error", errorMessage: "body failed after truncation", content: [{ type: "text", text: "partial" }] });
});

test("summary chat rejects malformed and incomplete tool arguments", async () => {
	for (const ended of [true, false]) {
		const result = await collectResponse(model, stream(
			{ type: EventType.TOOL_CALL_START, toolCallId: "call", toolCallName: "write" },
			{ type: EventType.TOOL_CALL_ARGS, toolCallId: "call", delta: '{"path":' },
			...(ended ? [{ type: EventType.TOOL_CALL_END, toolCallId: "call", input: {} } satisfies AdapterYieldChunk] : []),
			terminal("tool_calls"),
		));
		expect(result.stopReason).toBe("error");
	}
});

test("summary chat distinguishes length and deferred from a complete answer", async () => {
	const truncated = await collectResponse(model, stream(...text, terminal("length")));
	expect(truncated).toMatchObject({ stopReason: "length", content: [{ type: "text", text: "partial" }] });
	const geminiTail = await collectResponse(model, stream(
		text[0]!, text[1]!,
		{ type: EventType.RUN_ERROR, code: "max_tokens", message: "max_output_tokens" },
		text[2]!, terminal(),
	));
	expect(geminiTail).toMatchObject({ stopReason: "length", content: [{ type: "text", text: "partial" }] });
	const deferred = await collectResponse(model, stream({ ...terminal(), metadata: { forge: { stopReason: "deferred" } } }));
	expect(deferred.stopReason).toBe("deferred");
});

test("provider continuation signatures and original tool input survive history projection", () => {
	const saved: SessionMessage = { role: "assistant", content: [
		{ type: "thinking", thinking: "reasoning", thinkingSignature: "encrypted-signature" },
		{ type: "tool_call", id: "call", name: "read", arguments: { path: "a" }, thoughtSignature: '{"forge":"tanstack-tool","version":1,"metadata":{"itemId":"response-item","thoughtSignature":"gemini-signature"}}' },
	], timestamp: 1 };
	const history: SessionMessage[] = [saved, { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "source" }], details: { secretDisplayOnly: "ui" }, timestamp: 1 }];
	const projected = toModelMessages(history);
	expect(projected[0]).toMatchObject({ thinking: [{ content: "reasoning", signature: "encrypted-signature" }], toolCalls: [{ id: "call", function: { name: "read", arguments: '{"path":"a"}' }, metadata: { itemId: "response-item", thoughtSignature: "gemini-signature" } }] });
	expect(JSON.stringify(projected)).not.toContain("secretDisplayOnly");
	expect(history[0]).toEqual(saved);
	const old: SessionMessage = { role: "assistant", content: [{ type: "tool_call", id: "old", name: "read", arguments: {}, thoughtSignature: '{"forge":"openai-responses","version":1,"itemId":"legacy-item"}' }], timestamp: 0 };
	expect(toModelMessages([old])[0]?.toolCalls?.[0]?.metadata).toEqual({ itemId: "legacy-item" });
});

test("provider-executed tool history keeps later reasoning in a separate model segment", () => {
	const history: SessionMessage[] = [{ role: "assistant", timestamp: 1, content: [
		{ type: "thinking", thinking: "before", thinkingSignature: "first" },
		{ type: "tool_call", id: "provider-call", name: "web_search", arguments: { query: "source" }, thoughtSignature: '{"forge":"tanstack-tool","version":1,"metadata":{"providerExecuted":true}}' },
		{ type: "thinking", thinking: "after", thinkingSignature: "second" },
		{ type: "text", text: "answer" },
	] }];
	const projected = toModelMessages(history);
	expect(projected).toHaveLength(2);
	expect(projected[0]).toMatchObject({ thinking: [{ content: "before", signature: "first" }], toolCalls: [{ id: "provider-call" }] });
	expect(projected[1]).toMatchObject({ thinking: [{ content: "after", signature: "second" }], content: "answer", toolCalls: [] });
});

test("unknown and duplicate provider terminals cannot complete a summary", async () => {
	for (const chunks of [
		[...text, { ...terminal(), finishReason: "new-reason" as never }],
		[...text, terminal(), terminal()],
	]) {
		const result = await collectResponse(model, stream(...chunks));
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	}
});

test("a terminal cannot complete an open text event", async () => {
	const result = await collectResponse(model, stream(text[0]!, text[1]!, terminal()));
	expect(result.stopReason).toBe("error");
	expect(result.content).toEqual([{ type: "text", text: "partial" }]);
});

test("orphan or unfinished reasoning events cannot complete a response", async () => {
	for (const chunks of [
		[{ type: EventType.REASONING_MESSAGE_END, messageId: "orphan" } satisfies AdapterYieldChunk],
		[{ type: EventType.REASONING_END, messageId: "orphan" } satisfies AdapterYieldChunk],
		[{ type: EventType.STEP_FINISHED, stepId: "orphan", stepName: "thinking", content: "unpaired" } satisfies AdapterYieldChunk],
		[{ type: EventType.REASONING_MESSAGE_START, messageId: "open", role: "reasoning" } satisfies AdapterYieldChunk],
		[{ type: EventType.REASONING_START, messageId: "open" } satisfies AdapterYieldChunk],
		[{ type: EventType.REASONING_START, messageId: "repeat" } satisfies AdapterYieldChunk,
			{ type: EventType.REASONING_END, messageId: "repeat" } satisfies AdapterYieldChunk,
			{ type: EventType.REASONING_END, messageId: "repeat" } satisfies AdapterYieldChunk],
		[{ type: EventType.STEP_STARTED, stepId: "open", stepName: "thinking", stepType: "thinking" } satisfies AdapterYieldChunk,
			{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "open", delta: "partial" } satisfies AdapterYieldChunk],
		[{ type: EventType.STEP_STARTED, stepId: "active", stepName: "thinking", stepType: "thinking" } satisfies AdapterYieldChunk,
			{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "orphan", delta: "misattributed" } satisfies AdapterYieldChunk,
			{ type: EventType.STEP_FINISHED, stepId: "active", stepName: "thinking", content: "misattributed" } satisfies AdapterYieldChunk],
		[{ type: EventType.STEP_STARTED, stepId: "active", stepName: "thinking", stepType: "thinking" } satisfies AdapterYieldChunk,
			{ type: EventType.REASONING_MESSAGE_START, messageId: "linked", role: "reasoning" } satisfies AdapterYieldChunk,
			{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "orphan", delta: "misattributed" } satisfies AdapterYieldChunk],
	]) {
		const result = await collectResponse(model, stream(...chunks, terminal()));
		expect(result.stopReason).toBe("error");
	}
});

test("raw audit drains an error response before settling its terminal", async () => {
	let afterError = false;
	const response = await collectResponse(model, (async function* () {
		yield { type: EventType.RUN_ERROR, message: "provider failed", code: "503" } satisfies AdapterYieldChunk;
		afterError = true;
		yield terminal();
	})());
	expect(afterError).toBe(true);
	expect(response.stopReason).toBe("error");
});

test("raw error usage keeps cache accounting on a partial answer", async () => {
	for (const api of ["openai-responses", "anthropic-messages"] as const) {
		const result = await collectResponse({ ...model, api }, stream(...text, { type: EventType.RUN_ERROR, code: "503", message: "unavailable", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, promptTokensDetails: { cachedTokens: 30, cacheWriteTokens: 10 } } }));
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "503: unavailable", content: [{ type: "text", text: "partial" }], usage: { input: api === "anthropic-messages" ? 100 : 60, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: api === "anthropic-messages" ? 160 : 120 } });
	}
});

test("custom adapter explicit cost is distinct from missing cost", async () => {
	for (const cost of [undefined, 0, 0.02]) {
		const result = await collectResponse(model, stream({ ...terminal(), usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20, ...(cost !== undefined ? { cost } : {}) } }));
		expect(result.usage).toMatchObject({ input: 15, output: 5, totalTokens: 20 });
		expect(result.usage?.cost?.total).toBe(cost);
	}
});

test("opaque text and redacted thinking retain their provider semantics", () => {
	const projected = toModelMessages([{ role: "assistant", timestamp: 1, content: [
		{ type: "text", text: "prior answer", textSignature: "opaque-text" },
		{ type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true },
	] }]);
	expect(projected[0]?.content).toEqual([{ type: "text", content: "prior answer", metadata: { forge: { textSignature: "opaque-text" } } }]);
	expect(projected[0]?.thinking).toMatchObject([{ content: "", signature: "encrypted" }]);
	expect((projected[0]?.thinking?.[0] as { redacted?: boolean })?.redacted).toBe(true);
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
			const result = await nativeRequest(selected, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], { apiKey: "fixture-key", maxTokens: 100 });
			expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 5, output: 2 } });
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
		const response = await nativeRequest(selected, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], { apiKey: "fixture-key", maxTokens: 100, signal: AbortSignal.timeout(2500) });
		expect(response.stopReason).toBe("error");
		expect(requests).toBe(1);
	} finally { server.stop(true); }
});
