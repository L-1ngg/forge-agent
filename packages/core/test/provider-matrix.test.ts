import { expect, test } from "bun:test";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, MemorySessionStorage } from "../src/sdk.ts";
import { SessionStore } from "../src/index.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import { modelResponse } from "./helpers/model-response.ts";

const protocols = [
	{ api: "openai-completions", provider: "deepseek", model: "deepseek-v4-flash" },
	{ api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5" },
	{ api: "bedrock-converse-stream", provider: "amazon-bedrock", model: "amazon.nova-2-lite-v1:0" },
	{ api: "openai-responses", provider: "xai", model: "grok-4.3" },
	{ api: "azure-openai-responses", provider: "azure-openai-responses", model: "gpt-4.1-mini" },
	{ api: "google-generative-ai", provider: "google", model: "gemini-2.5-flash" },
	{ api: "google-vertex", provider: "google-vertex", model: "gemini-2.5-flash" },
] as const;

type Protocol = typeof protocols[number];

function bedrockEvents(events: Array<{ type: string; payload: object }>): Response {
	const encoder = new TextEncoder();
	const codec = new EventStreamCodec(value => new TextDecoder().decode(value), value => encoder.encode(value));
	const frames = events.map(event => codec.encode({
		headers: { ":event-type": { type: "string", value: event.type }, ":message-type": { type: "string", value: "event" }, ":content-type": { type: "string", value: "application/json" } },
		body: encoder.encode(JSON.stringify(event.payload)),
	}));
	const body = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
	let offset = 0;
	for (const frame of frames) { body.set(frame, offset); offset += frame.length; }
	return new Response(body, { headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-bedrock-content-type": "application/json" } });
}

function textResponse(protocol: Protocol, text: string): Response {
	switch (protocol.api) {
		case "openai-completions": return new Response([
			{ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
			{ id: "chatcmpl_fixture", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "anthropic-messages": return modelResponse([], "end_turn", text);
		case "bedrock-converse-stream": return bedrockEvents([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
			{ type: "messageStop", payload: { stopReason: "end_turn" } },
			{ type: "metadata", payload: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 1 } } },
		]);
		case "openai-responses":
		case "azure-openai-responses": return new Response([
			{ type: "response.created", response: { id: "resp_fixture", model: protocol.model, status: "in_progress" } },
			{ type: "response.completed", response: { id: "resp_fixture", model: protocol.model, status: "completed", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "google-generative-ai":
		case "google-vertex": return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
}

function toolResponse(protocol: Protocol, value: unknown = "once"): Response {
	const call = { id: "call-fixture", name: "echo", arguments: { value } };
	switch (protocol.api) {
		case "openai-completions": return new Response([
			{ id: "chatcmpl_tool", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
			{ id: "chatcmpl_tool", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "anthropic-messages": return new Response([
			{ type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: protocol.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "checking" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "matrix-anthropic-signature" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } },
			{ type: "message_stop" },
		].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "bedrock-converse-stream": return bedrockEvents([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { reasoningContent: { text: "checking" } } } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "matrix-bedrock-signature" } } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 1, start: { toolUse: { toolUseId: call.id, name: call.name } } } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 1, delta: { toolUse: { input: JSON.stringify(call.arguments) } } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 1 } },
			{ type: "messageStop", payload: { stopReason: "tool_use" } },
		]);
		case "openai-responses":
		case "azure-openai-responses": return new Response([
			{ type: "response.created", response: { id: "resp_tool", model: protocol.model, status: "in_progress" } },
			{ type: "response.completed", response: { id: "resp_tool", model: protocol.model, status: "completed", output: [{ type: "reasoning", id: "rs-matrix", encrypted_content: "matrix-encrypted-reasoning", summary: [] }, { type: "function_call", id: "fc-fixture", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "google-generative-ai":
		case "google-vertex": return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: call.id, name: call.name, args: call.arguments }, thoughtSignature: "matrix-signature" }] }, finishReason: "STOP" }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
}

function lengthResponse(protocol: Protocol): Response {
	switch (protocol.api) {
		case "openai-completions": return new Response([
			{ id: "chatcmpl_length", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] },
			{ id: "chatcmpl_length", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "anthropic-messages": return modelResponse([], "max_tokens", "partial");
		case "bedrock-converse-stream": return bedrockEvents([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "partial" } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
			{ type: "messageStop", payload: { stopReason: "max_tokens" } },
		]);
		case "openai-responses":
		case "azure-openai-responses": return new Response([
			{ type: "response.created", response: { id: "resp_length", model: protocol.model, status: "in_progress" } },
			{ type: "response.incomplete", response: { id: "resp_length", model: protocol.model, status: "incomplete", output: [{ type: "message", id: "msg_length", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "partial", annotations: [] }] }], incomplete_details: { reason: "max_output_tokens" } } },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "google-generative-ai":
		case "google-vertex": return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
}

function truncatedResponse(protocol: Protocol): Response {
	switch (protocol.api) {
		case "openai-completions": return new Response(`data: ${JSON.stringify({ id: "chatcmpl_partial", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
		case "anthropic-messages": return new Response([
			{ type: "message_start", message: { id: "msg_partial", type: "message", role: "assistant", model: protocol.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "bedrock-converse-stream": return bedrockEvents([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "partial" } } },
			{ type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
		]);
		case "openai-responses":
		case "azure-openai-responses": return new Response([
			{ type: "response.created", response: { id: "resp_partial", model: protocol.model, status: "in_progress" } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		case "google-generative-ai":
		case "google-vertex": return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
}

async function heldTextResponse(protocol: Protocol): Promise<Response> {
	let bytes: Uint8Array;
	let contentType = "text/event-stream";
	if (protocol.api === "bedrock-converse-stream") {
		bytes = new Uint8Array(await bedrockEvents([
			{ type: "messageStart", payload: { role: "assistant" } },
			{ type: "contentBlockStart", payload: { contentBlockIndex: 0 } },
			{ type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "working" } } },
		]).arrayBuffer());
		contentType = "application/vnd.amazon.eventstream";
	} else {
		const events: unknown[] = protocol.api === "openai-completions"
			? [{ id: "chatcmpl_hold", object: "chat.completion.chunk", model: protocol.model, choices: [{ index: 0, delta: { role: "assistant", content: "working" }, finish_reason: null }] }]
			: protocol.api === "anthropic-messages"
				? [
					{ type: "message_start", message: { id: "msg_hold", type: "message", role: "assistant", model: protocol.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } },
				]
				: protocol.api === "openai-responses" || protocol.api === "azure-openai-responses"
					? [
						{ type: "response.created", response: { id: "resp_hold", model: protocol.model, status: "in_progress" } },
						{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "working" },
					]
					: [{ candidates: [{ content: { role: "model", parts: [{ text: "working" }] } }] }];
		bytes = new TextEncoder().encode(events.map(event => `${protocol.api === "anthropic-messages" && "type" in (event as object) ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""));
	}
	return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); } }), { headers: { "content-type": contentType, ...(protocol.api === "bedrock-converse-stream" ? { "x-amzn-bedrock-content-type": "application/json" } : {}) } });
}

for (const protocol of protocols) test(`${protocol.api} summary uses its built-in adapter`, async () => {
	const requests: unknown[] = [];
	const checkpoint = JSON.stringify({ states: [], claims: [], taskChanged: false });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		return textResponse(protocol, checkpoint);
	} });
	const storage = new MemorySessionStorage([
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "old goal" }] },
		{ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "work ".repeat(1500) }] },
		{ role: "user", timestamp: 3, content: [{ type: "text", text: "continue" }] },
	]);
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", storage, thinkingLevel: "off", maxTokens: 100, context: { keepRecentTokens: 1 }, retry: { enabled: false } });
	try {
		expect(await agent.compact()).toMatchObject({ status: "complete" });
		expect(requests.length).toBeGreaterThan(0);
		expect(JSON.stringify(requests[0])).toContain("context summarization assistant");
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} tool result continues through its built-in adapter`, async () => {
	const requests: unknown[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		return requests.length === 1 ? toolResponse(protocol) : textResponse(protocol, "finished");
	} });
	let executions = 0;
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute(args) { executions++; expect(args).toEqual({ value: "once" }); return { content: [{ type: "text", text: "once" }], details: {} }; } },
	] });
	try {
		const turn = agent.runTurn("call echo");
		const reasons: string[] = [];
		for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason) reasons.push(event.message.stopReason);
		expect(await turn.result).toEqual({ status: "success" });
		expect(reasons).toEqual(["tool_use", "stop"]);
		expect(executions).toBe(1);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain("call-fixture");
		expect(JSON.stringify(requests[1])).toContain("once");
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} rejects invalid tool arguments before execution`, async () => {
	const requests: unknown[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		return requests.length === 1 ? toolResponse(protocol, 23) : textResponse(protocol, "input rejected");
	} });
	let executions = 0;
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute() { executions++; return { content: [{ type: "text", text: "ran" }], details: {} }; } },
	] });
	try {
		const turn = agent.runTurn("call echo");
		for await (const _event of turn) {}
		expect(await turn.result).toEqual({ status: "success" });
		expect(executions).toBe(0);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain("value");
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} token limit is length, not success`, async () => {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return lengthResponse(protocol); } });
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false } });
	try {
		let reason: string | undefined;
		for await (const event of agent.runTurn("hello")) if (event.type === "message_end" && event.message.role === "assistant") reason = event.message.stopReason;
		expect(reason).toBe("length");
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} HTTP 503 cannot execute a tool`, async () => {
	let executions = 0;
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ message: "fixture unavailable" }, { status: 503 }); } });
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute() { executions++; return { content: [{ type: "text", text: "ran" }], details: {} }; } },
	] });
	try {
		let reason: string | undefined;
		for await (const event of agent.runTurn("call echo")) if (event.type === "message_end" && event.message.role === "assistant") reason = event.message.stopReason;
		expect(reason).toBe("error");
		expect(requests).toBe(1);
		expect(executions).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} HTTP 429 cannot execute a tool`, async () => {
	let requests = 0;
	let executions = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "1" } }); } });
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute() { executions++; return { content: [{ type: "text", text: "ran" }], details: {} }; } },
	] });
	try {
		let reason: string | undefined;
		for await (const event of agent.runTurn("call echo")) if (event.type === "message_end" && event.message.role === "assistant") reason = event.message.stopReason;
		expect(reason).toBe("error");
		expect(requests).toBe(1);
		expect(executions).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} malformed protocol response cannot execute a tool`, async () => {
	let executions = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
		return protocol.api === "bedrock-converse-stream"
			? bedrockEvents([{ type: "messageStart", payload: { role: "assistant" } }, { type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { toolUse: { input: "{" } } } }])
			: new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } });
	} });
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async execute() { executions++; return { content: [{ type: "text", text: "ran" }], details: {} }; } },
	] });
	try {
		let reason: string | undefined;
		for await (const event of agent.runTurn("call echo")) if (event.type === "message_end" && event.message.role === "assistant") reason = event.message.stopReason;
		expect(reason).toBe("error");
		expect(executions).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} premature EOF is an error`, async () => {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return truncatedResponse(protocol); } });
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false } });
	try {
		let reason: string | undefined;
		for await (const event of agent.runTurn("hello")) if (event.type === "message_end" && event.message.role === "assistant") reason = event.message.stopReason;
		expect(reason).toBe("error");
	} finally { await agent.dispose(); server.stop(true); }
});

for (const protocol of protocols) test(`${protocol.api} replays saved assistant history after JSONL reopen`, async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-provider-history-"));
	const path = join(directory, "session.jsonl");
	const requests: unknown[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		return textResponse(protocol, requests.length === 1 ? "first answer" : "continued");
	} });
	const options = { provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: directory, systemPrompt: "test", thinkingLevel: "off" as const, maxTokens: 100, context: { enabled: false }, retry: { enabled: false } };
	try {
		const first = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		try {
			const turn = first.runTurn("first");
			let answer: SessionMessage | undefined;
			for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant") answer = event.message;
			expect(await turn.result).toEqual({ status: "success" });
			expect(answer?.content).toContainEqual({ type: "text", text: "first answer" });
			expect(answer?.usage).toMatchObject({ input: protocol.api === "anthropic-messages" ? 10 : 5, output: protocol.api === "anthropic-messages" ? 5 : 2 });
			expect(answer?.usage?.cost?.total).toBeGreaterThan(0);
		} finally { await first.dispose(); }
		const reopened = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		try {
			const turn = reopened.runTurn("second");
			for await (const _event of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
		} finally { await reopened.dispose(); }
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain("first answer");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

for (const protocol of protocols) test(`${protocol.api} preserves tool pairing through compaction and JSONL reopen`, async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-provider-compact-"));
	const path = join(directory, "session.jsonl");
	const requests: unknown[] = [];
	const checkpoint = JSON.stringify({ states: [], claims: [], taskChanged: false });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body: unknown = await request.json();
		requests.push(body);
		if (JSON.stringify(body).includes("context summarization assistant")) return textResponse(protocol, checkpoint);
		if (requests.length === 2) return toolResponse(protocol);
		return textResponse(protocol, "done");
	} });
	let executions = 0;
	const options = { provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: directory, systemPrompt: "test", thinkingLevel: "off" as const, maxTokens: 100, context: { keepRecentTokens: 2000 }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow" as const, source: "hook" as const }) }] }, tools: [
		{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"], additionalProperties: false }, async execute() { executions++; return { content: [{ type: "text" as const, text: "once" }], details: {} }; } },
	] };
	try {
		const first = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		try {
			const old = first.runTurn("Old context ".repeat(2000));
			for await (const _event of old) {}
			expect(await old.result).toEqual({ status: "success" });
			const turn = first.runTurn("call echo");
			for await (const _event of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
			expect(await first.compact()).toMatchObject({ status: "complete" });
		} finally { await first.dispose(); }
		const reopened = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		try {
			const turn = reopened.runTurn("continue");
			for await (const _event of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
		} finally { await reopened.dispose(); }
		expect(executions).toBe(1);
		const next = JSON.stringify(requests.at(-1));
		expect(next).toContain("call-fixture");
		expect(next).toContain("once");
		if (protocol.api === "google-generative-ai" || protocol.api === "google-vertex") expect(next).toContain('"thoughtSignature":"matrix-signature"');
		if (protocol.api === "anthropic-messages") expect(next).toContain("matrix-anthropic-signature");
		if (protocol.api === "bedrock-converse-stream") expect(next).toContain("matrix-bedrock-signature");
		if (protocol.api === "openai-responses" || protocol.api === "azure-openai-responses") expect(next).toContain("matrix-encrypted-reasoning");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

for (const protocol of protocols) test(`${protocol.api} cancels an open response after a text delta`, async () => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { requests++; return heldTextResponse(protocol); } });
	const agent = await createAgent({ provider: protocol.provider, model: protocol.model, apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off", maxTokens: 100, context: { enabled: false }, retry: { enabled: false } });
	const timer = setTimeout(() => agent.abort(), 200);
	try {
		let answer: { stopReason?: string } | undefined;
		let sawDelta = false;
		for await (const event of agent.runTurn("hello")) {
			if (event.type === "message_delta") { sawDelta = true; agent.abort(); }
			if (event.type === "message_end" && event.message.role === "assistant") answer = event.message;
		}
		expect(sawDelta).toBe(true);
		expect(answer?.stopReason).toBe("aborted");
		expect(requests).toBe(1);
	} finally { clearTimeout(timer); await agent.dispose(); server.stop(true); }
});
