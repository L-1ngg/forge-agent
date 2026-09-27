import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { getCatalogModel, listCatalogModels, listCatalogProviders } from "../src/model-catalog.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import { createAgent, MemorySessionStorage } from "../src/sdk.ts";
import { assertBuiltinTransport } from "../src/model-adapter.ts";
import { collectResponse, nativeRequest } from "./helpers/native-request.ts";
import { modelResponse } from "./helpers/model-response.ts";
import { EventType } from "@tanstack/ai";

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const sse = (events: unknown[]) => new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
const responses = sse([
	{ type: "response.created", response: { id: "resp_fixture", model: "grok-4.3", status: "in_progress" } },
	{ type: "response.completed", response: { id: "resp_fixture", model: "grok-4.3", status: "completed", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
]);

function bedrockStream(events: Array<{ type: string; payload: object }>): Response {
	const encoder = new TextEncoder();
	const codec = new EventStreamCodec(value => new TextDecoder().decode(value), value => encoder.encode(value));
	const frames = events.map(event => codec.encode({
		headers: { ":event-type": { type: "string", value: event.type }, ":message-type": { type: "string", value: "event" }, ":content-type": { type: "string", value: "application/json" } },
		body: encoder.encode(JSON.stringify(event.payload)),
	}));
	const body = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
	let offset = 0;
	for (const frame of frames) { body.set(frame, offset); offset += frame.length; }
	return new Response(body, { headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-bedrock-content-type": "application/json" } });
}

async function run(provider: string, model: string, reply: () => Response, thinkingLevel: "off" | "medium" = "off") {
	let url = "";
	let body: unknown;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		url = request.url;
		body = await request.json();
		return reply();
	} });
	const agent = await createAgent({ provider, model, apiKey: "fixture-key", baseUrl: server.url.toString(), systemPrompt: "SYSTEM", thinkingLevel, maxTokens: 100, cwd: process.cwd(), context: { enabled: false }, retry: { enabled: false } });
	try {
		let answer: SessionMessage | undefined;
		const turn = agent.runTurn("hello");
		for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant") answer = event.message;
		return { url, body, answer };
	} finally { await agent.dispose(); server.stop(true); }
}

test("every retained catalog model selects a TanStack transport", () => {
	let selected = 0;
	for (const provider of listCatalogProviders()) for (const model of listCatalogModels(provider)) {
		expect(() => assertBuiltinTransport(model)).not.toThrow();
		selected++;
	}
	expect(selected).toBe(1314);
});

test("a late adapter success cannot override a canceled request", async () => {
	const controller = new AbortController();
	const model = getCatalogModel("deepseek", "deepseek-v4-flash")!;
	const response = await collectResponse(model, (async function* () {
		controller.abort();
		yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run", timestamp: Date.now(), finishReason: "stop" };
	})(), controller.signal);
	expect(response.stopReason).toBe("aborted");
});

test("OpenAI-compatible Chat Completions sends the catalog model and system prompt", async () => {
	const result = await run("deepseek", "deepseek-v4-flash", () => sse([
		{ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
		{ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
	]));
	expect(result.url).toEndWith("/chat/completions");
	expect(result.body).toMatchObject({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "SYSTEM" }, { role: "user", content: "hello" }] });
	expect(result.answer).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }] });
});

test("Chat Completions EOF without finish_reason is an error", async () => {
	const result = await run("deepseek", "deepseek-v4-flash", () => sse([
		{ id: "chatcmpl_partial", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] },
	]));
	expect(result.answer?.stopReason).toBe("error");
});

test("compatible Chat Completions maps provider reasoning fields", async () => {
	for (const scenario of [
		{ provider: "openrouter", model: "aion-labs/aion-2.0", thinkingLevel: "medium", expected: { max_completion_tokens: 100, reasoning: { effort: "medium" } } },
		{ provider: "qwen-token-plan", model: "MiniMax-M2.5", thinkingLevel: "off", expected: { max_completion_tokens: 100, enable_thinking: false } },
		{ provider: "zai", model: "glm-4.7", thinkingLevel: "off", expected: { max_tokens: 100, thinking: { type: "disabled" } } },
	] as const) {
		const result = await run(scenario.provider, scenario.model, () => sse([
			{ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: scenario.model, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
			{ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: scenario.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		]), scenario.thinkingLevel);
		expect(result.answer?.stopReason).toBe("stop");
		expect(result.body).toMatchObject(scenario.expected);
	}
});

test("Responses-compatible provider uses the Responses endpoint", async () => {
	const result = await run("xai", "grok-4.3", () => responses.clone());
	expect(result.url).toEndWith("/responses");
	expect(result.body).toMatchObject({ model: "grok-4.3", store: false });
	expect(result.answer).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }] });
});

test("Gemini request uses the model and emits a successful answer", async () => {
	const result = await run("google", "gemini-2.5-flash", () => sse([
		{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } },
	]));
	expect(result.url).toContain("gemini-2.5-flash:streamGenerateContent");
	expect(result.body).toMatchObject({ contents: [{ role: "user", parts: [{ text: "hello" }] }] });
	expect(result.body).toMatchObject({ generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } } });
	expect(result.answer).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }] });
});

test("Gemini reasoning budget reaches the request", async () => {
	const result = await run("google", "gemini-2.5-flash", () => sse([{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }]), "medium");
	expect(result.body).toMatchObject({ generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } } });
});

test("Gemini tool continuation preserves the thought signature", async () => {
	const bodies: unknown[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		bodies.push(await request.json());
		return bodies.length === 1
			? sse([{ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "echo", args: { value: "ok" } }, thoughtSignature: "opaque-signature" }] }, finishReason: "STOP" }] }])
			: sse([{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
	} });
	let executions = 0;
	const agent = await createAgent({ provider: "google", model: "gemini-2.5-flash", apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute(args) { executions++; return { content: [{ type: "text", text: String((args as { value: string }).value) }], details: {} }; } }] });
	try {
		const turn = agent.runTurn("call echo");
		for await (const _event of turn) {}
		expect(await turn.result).toEqual({ status: "success" });
		expect(executions).toBe(1);
		expect(bodies).toHaveLength(2);
		expect(JSON.stringify(bodies[1])).toContain('"thoughtSignature":"opaque-signature"');
		expect(JSON.stringify(bodies[1])).toContain("functionResponse");
	} finally { await agent.dispose(); server.stop(true); }
});

test("Anthropic message_stop without a stop reason cannot complete the run", async () => {
	const result = await run("anthropic", "claude-sonnet-4-5", () => sse([
		{ type: "message_start", message: { id: "msg_partial", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_stop" },
	]));
	expect(result.answer?.stopReason).toBe("error");
});

test("Anthropic EOF before message_stop cannot complete the run", async () => {
	const result = await run("anthropic", "claude-sonnet-4-5", () => sse([
		{ type: "message_start", message: { id: "msg_partial", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	]));
	expect(result.answer?.stopReason).toBe("error");
});

test("Anthropic streaming request can be canceled", async () => {
	const bytes = new TextEncoder().encode([
		{ type: "message_start", message: { id: "msg_cancel", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } },
	].map(frame).join(""));
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); } }), { headers: { "content-type": "text/event-stream" } }); } });
	const agent = await createAgent({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture-key", baseUrl: server.url.toString(), systemPrompt: "test", thinkingLevel: "off", cwd: process.cwd(), retry: { enabled: false } });
	const timer = setTimeout(() => agent.abort(), 200);
	try {
		let answer: SessionMessage | undefined;
		for await (const event of agent.runTurn("hello")) {
			if (event.type === "message_delta") agent.abort();
			if (event.type === "message_end" && event.message.role === "assistant") answer = event.message;
		}
		expect(answer?.stopReason).toBe("aborted");
		expect(requests).toBe(1);
	} finally { clearTimeout(timer); await agent.dispose(); server.stop(true); }
});

test("Azure Responses uses the deployment endpoint and API version", async () => {
	const result = await run("azure-openai-responses", "gpt-4", () => responses.clone());
	expect(result.answer?.errorMessage).toBeUndefined();
	expect(result.url).toContain("/openai/v1/responses?api-version=v1");
	expect(result.body).toMatchObject({ model: "gpt-4", store: false });
	expect(result.answer?.stopReason).toBe("stop");
});

test("Azure request settings select endpoint, deployment and API version", async () => {
	let url = "";
	let body: unknown;
	let apiKey = "";
	let authorization: string | null = null;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		url = request.url;
		apiKey = request.headers.get("api-key") ?? "";
		authorization = request.headers.get("authorization");
		body = await request.json();
		return responses.clone();
	} });
	try {
		const model = getCatalogModel("azure-openai-responses", "gpt-4")!;
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { AZURE_OPENAI_API_KEY: "azure-fixture-key", AZURE_OPENAI_BASE_URL: server.url.toString(), AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4=deployment-fixture", AZURE_OPENAI_API_VERSION: "2024-10-21" },
		});
		expect(response.stopReason).toBe("stop");
		expect(url).toContain("/openai/v1/responses?api-version=2024-10-21");
		expect(body).toMatchObject({ model: "deployment-fixture" });
		expect(apiKey).toBe("azure-fixture-key");
		expect(authorization).toBeNull();
	} finally { server.stop(true); }
});

test("Cloudflare Anthropic gateway uses its URL template and gateway authentication only", async () => {
	let url = "";
	let gatewayAuth = "";
	let anthropicKey: string | null = null;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		url = request.url;
		gatewayAuth = request.headers.get("cf-aig-authorization") ?? "";
		anthropicKey = request.headers.get("x-api-key");
		return modelResponse();
	} });
	try {
		const model = getCatalogModel("cloudflare-ai-gateway", "claude-fable-5")!;
		model.baseUrl = `${server.url}v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic`;
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { CLOUDFLARE_API_KEY: "gateway-fixture", CLOUDFLARE_ACCOUNT_ID: "account-fixture", CLOUDFLARE_GATEWAY_ID: "gateway-fixture" },
		});
		expect(response.stopReason).toBe("stop");
		expect(url).toContain("/v1/account-fixture/gateway-fixture/anthropic/");
		expect(gatewayAuth).toBe("Bearer gateway-fixture");
		expect(anthropicKey).toBeNull();
	} finally { server.stop(true); }
});

for (const scenario of [
	{ name: "Anthropic OAuth", provider: "anthropic", model: "claude-sonnet-4-5", env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-fixture" }, token: "sk-ant-oat-fixture" },
	{ name: "Anthropic bearer", provider: "anthropic", model: "claude-sonnet-4-5", env: { ANTHROPIC_AUTH_TOKEN: "bearer-fixture" }, token: "bearer-fixture" },
	{ name: "Copilot Anthropic", provider: "github-copilot", model: "claude-fable-5", env: { COPILOT_GITHUB_TOKEN: "copilot-fixture" }, token: "copilot-fixture" },
]) test(`${scenario.name} authenticates with Bearer rather than x-api-key`, async () => {
	let authorization = "";
	let apiKey: string | null = null;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		authorization = request.headers.get("authorization") ?? "";
		apiKey = request.headers.get("x-api-key");
		return modelResponse();
	} });
	try {
		const model = getCatalogModel(scenario.provider, scenario.model)!;
		model.baseUrl = server.url.toString();
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], { env: scenario.env });
		expect(response.stopReason).toBe("stop");
		expect(authorization).toBe(`Bearer ${scenario.token}`);
		expect(apiKey).toBeNull();
	} finally { server.stop(true); }
});

test("Vertex Gemini express key reaches the configured endpoint", async () => {
	const result = await run("google-vertex", "gemini-2.5-flash", () => sse([
		{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] },
	]));
	expect(result.url).toContain("gemini-2.5-flash:streamGenerateContent");
	expect(result.answer?.stopReason).toBe("stop");
});

test("Vertex ADC file supplied to this request authenticates the model call", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-vertex-adc-"));
	const credentials = join(directory, "credentials.json");
	const subjectToken = join(directory, "subject-token");
	let tokenCalls = 0;
	let authorization = "";
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		if (new URL(request.url).pathname === "/token") {
			tokenCalls++;
			return Response.json({ access_token: "adc-fixture-token", token_type: "Bearer", expires_in: 3600 });
		}
		authorization = request.headers.get("authorization") ?? "";
		return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
	} });
	try {
		await writeFile(subjectToken, "fixture-subject-token");
		await writeFile(credentials, JSON.stringify({ type: "external_account", audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/fixture/providers/local", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: new URL("/token", server.url).toString(), credential_source: { file: subjectToken } }));
		const model = getCatalogModel("google-vertex", "gemini-2.5-flash")!;
		model.baseUrl = server.url.toString();
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { GOOGLE_CLOUD_PROJECT: "fixture-project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: credentials },
		});
		expect(response).toMatchObject({ stopReason: "stop" });
		expect(tokenCalls).toBe(1);
		expect(authorization).toBe("Bearer adc-fixture-token");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Bedrock Converse bearer request reaches the configured endpoint", async () => {
	const result = await run("amazon-bedrock", "amazon.nova-2-lite-v1:0", () => Response.json({ message: "fixture failure" }, { status: 503 }));
	expect(result.url).toContain("/model/amazon.nova-2-lite-v1%3A0/converse-stream");
	expect(result.answer?.stopReason).toBe("error");
});

test("Bedrock HTTP event stream produces a complete Forge answer", async () => {
	const result = await run("amazon-bedrock", "amazon.nova-2-lite-v1:0", () => bedrockStream([
		{ type: "messageStart", payload: { role: "assistant" } },
		{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
		{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "done" } } },
		{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
		{ type: "messageStop", payload: { stopReason: "end_turn" } },
		{ type: "metadata", payload: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 1 } } },
	]));
	expect(result.answer).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }] });
});

test("Bedrock summary request uses Converse and accepts a structured checkpoint", async () => {
	let body: unknown;
	const checkpoint = JSON.stringify({ states: [], claims: [], taskChanged: false });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		body = await request.json();
		return bedrockStream([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: checkpoint } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
			{ type: "messageStop", payload: { stopReason: "end_turn" } },
			{ type: "metadata", payload: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 1 } } },
		]);
	} });
	const agent = await createAgent({ provider: "amazon-bedrock", model: "amazon.nova-2-lite-v1:0", apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", storage: new MemorySessionStorage([
		{ role: "user", content: [{ type: "text", text: "old goal" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "work ".repeat(1500) }], timestamp: 2, stopReason: "stop" },
		{ role: "user", content: [{ type: "text", text: "recent" }], timestamp: 3 },
	]), context: { keepRecentTokens: 1, reserveTokens: 1000, summaryReasoning: "off" }, retry: { enabled: false } });
	try {
		expect((await agent.compact()).status).toBe("complete");
		expect(body).toMatchObject({ messages: expect.any(Array), inferenceConfig: expect.any(Object) });
		expect(JSON.stringify(body)).toContain("structured");
	} finally { await agent.dispose(); server.stop(true); }
});

test("Bedrock Converse tool use executes once and resumes with its result", async () => {
	const requests: unknown[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		return requests.length === 1 ? bedrockStream([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call-fixture", name: "echo" } } } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { toolUse: { input: '{"value":"ok"}' } } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
			{ type: "messageStop", payload: { stopReason: "tool_use" } },
		]) : bedrockStream([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "done" } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
			{ type: "messageStop", payload: { stopReason: "end_turn" } },
		]);
	} });
	let executions = 0;
	const agent = await createAgent({ provider: "amazon-bedrock", model: "amazon.nova-2-lite-v1:0", apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute() { executions++; return { content: [{ type: "text", text: "ok" }], details: {} }; } },
	] });
	try {
		const turn = agent.runTurn("call echo");
		for await (const _event of turn) {}
		expect(await turn.result).toEqual({ status: "success" });
		expect(executions).toBe(1);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain('"toolUseId":"call-fixture"');
		expect(JSON.stringify(requests[1])).toContain('"status":"success"');
	} finally { await agent.dispose(); server.stop(true); }
});

test("Bedrock Converse stream cancellation settles as aborted", async () => {
	const partial = new Uint8Array(await bedrockStream([
		{ type: "messageStart", payload: { role: "assistant" } },
		{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
		{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "working" } } },
	]).arrayBuffer());
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
		requests++;
		return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(partial); } }), { headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-bedrock-content-type": "application/json" } });
	} });
	const agent = await createAgent({ provider: "amazon-bedrock", model: "amazon.nova-2-lite-v1:0", apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", retry: { enabled: false } });
	const timer = setTimeout(() => agent.abort(), 200);
	try {
		let answer: SessionMessage | undefined;
		for await (const event of agent.runTurn("hello")) {
			if (event.type === "message_delta") agent.abort();
			if (event.type === "message_end" && event.message.role === "assistant") answer = event.message;
		}
		expect(answer?.stopReason).toBe("aborted");
		expect(requests).toBe(1);
	} finally { clearTimeout(timer); await agent.dispose(); server.stop(true); }
});

test("Bedrock signs with credentials supplied to this request", async () => {
	let authorization = "";
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		authorization = request.headers.get("authorization") ?? "";
		return Response.json({ message: "fixture failure" }, { status: 503 });
	} });
	try {
		const model = getCatalogModel("amazon-bedrock", "amazon.nova-2-lite-v1:0")!;
		model.baseUrl = server.url.toString();
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { AWS_ACCESS_KEY_ID: "AKIDFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_REGION: "us-east-1" },
		});
		expect(response.stopReason).toBe("error");
		expect(authorization).toContain("Credential=AKIDFIXTURE/");
	} finally { server.stop(true); }
});

test("Bedrock resolves the request's AWS profile from its credentials file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-bedrock-profile-"));
	const credentials = join(directory, "credentials");
	let authorization = "";
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		authorization = request.headers.get("authorization") ?? "";
		return Response.json({ message: "fixture failure" }, { status: 503 });
	} });
	try {
		await writeFile(credentials, "[fixture]\naws_access_key_id = PROFILEFIXTURE\naws_secret_access_key = profile-secret\n");
		const model = getCatalogModel("amazon-bedrock", "amazon.nova-2-lite-v1:0")!;
		model.baseUrl = server.url.toString();
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { AWS_PROFILE: "fixture", AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_REGION: "us-east-1" },
		});
		expect(response.stopReason).toBe("error");
		expect(authorization).toContain("Credential=PROFILEFIXTURE/");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Bedrock resolves container credentials supplied to this request", async () => {
	let credentialCalls = 0;
	let authorization = "";
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		if (new URL(request.url).pathname === "/credentials") {
			credentialCalls++;
			return Response.json({ AccessKeyId: "CONTAINERFIXTURE", SecretAccessKey: "container-secret", Token: "container-token", Expiration: new Date(Date.now() + 3600_000).toISOString() });
		}
		authorization = request.headers.get("authorization") ?? "";
		return Response.json({ message: "fixture failure" }, { status: 503 });
	} });
	try {
		const model = getCatalogModel("amazon-bedrock", "amazon.nova-2-lite-v1:0")!;
		model.baseUrl = server.url.toString();
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: new URL("/credentials", server.url).toString(), AWS_REGION: "us-east-1" },
		});
		expect(response.stopReason).toBe("error");
		expect(credentialCalls).toBe(1);
		expect(authorization).toContain("Credential=CONTAINERFIXTURE/");
	} finally { server.stop(true); }
});

test("Bedrock assumes a web identity role supplied to this request", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-bedrock-role-"));
	const tokenFile = join(directory, "token");
	let stsCalls = 0;
	let authorization = "";
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		if (!new URL(request.url).pathname.includes("/model/")) {
			stsCalls++;
			expect(await request.text()).toContain("AssumeRoleWithWebIdentity");
			return new Response(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ROLEFIXTURE</AccessKeyId><SecretAccessKey>role-secret</SecretAccessKey><SessionToken>role-token</SessionToken><Expiration>${new Date(Date.now() + 3600_000).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`, { headers: { "content-type": "text/xml" } });
		}
		authorization = request.headers.get("authorization") ?? "";
		return Response.json({ message: "fixture failure" }, { status: 503 });
	} });
	try {
		await writeFile(tokenFile, "fixture-identity-token");
		const model = getCatalogModel("amazon-bedrock", "amazon.nova-2-lite-v1:0")!;
		model.baseUrl = server.url.toString();
		const response = await nativeRequest(model, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }], {
			env: { AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/fixture", AWS_ENDPOINT_URL_STS: new URL("/sts", server.url).toString(), AWS_REGION: "us-east-1" },
		});
		expect(response.stopReason).toBe("error");
		expect(stsCalls).toBe(1);
		expect(authorization).toContain("Credential=ROLEFIXTURE/");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Bedrock Claude reasoning reaches additional model request fields", async () => {
	const result = await run("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0", () => Response.json({ message: "fixture failure" }, { status: 503 }), "medium");
	expect(result.body).toMatchObject({ inferenceConfig: { maxTokens: 8292 }, additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 8192 } } });
});
