import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, MemorySessionStorage } from "../src/sdk.ts";
import { SessionStore } from "../src/index.ts";
import type { SessionMessage } from "@forge-agent/protocol";

const base = { provider: "openai", model: "gpt-4o-mini", apiKey: "fixture-key", systemPrompt: "TASK SYSTEM", thinkingLevel: "off" as const, cwd: process.cwd(), context: { enabled: false } };
const output = (text: string) => ({ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const completed = (items: unknown[], usage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 }) => [
	{ type: "response.created", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "in_progress" } },
	{ type: "response.completed", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "completed", output: items, usage } },
];
const sse = (events: unknown[]) => new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });

test.each(["completed", "failed", "incomplete", "missing"] as const)("OpenAI TanStack terminal: %s", async terminal => {
	const item = output("partial answer");
	const events: unknown[] = [
		{ type: "response.created", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "in_progress" } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial answer" },
	];
	if (terminal === "completed") events.push({ type: "response.completed", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } });
	if (terminal === "failed") events.push({ type: "response.failed", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "failed", output: [item], error: { code: "server_error", message: "fixture failure" } } });
	if (terminal === "incomplete") events.push({ type: "response.incomplete", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "incomplete", output: [item], incomplete_details: { reason: "max_output_tokens" } } });
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json()); return sse(events); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), retry: { enabled: false } });
	try {
		let reply: SessionMessage | undefined;
		const turn = agent.runTurn("hello");
		for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
		expect(reply?.stopReason).toBe(terminal === "completed" ? "stop" : terminal === "incomplete" ? "length" : "error");
		expect(reply?.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial answer" }));
		if (terminal === "completed") expect(reply?.usage).toMatchObject({ input: 12, output: 4 });
		if (terminal === "missing") expect(reply?.errorMessage).toContain("terminal response event");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ model: "gpt-4o-mini", store: false, input: [{ role: "user" }] });
	} finally { await agent.dispose(); server.stop(true); }
});

test("OpenAI completed response does not wait for HTTP EOF", async () => {
	const bytes = new TextEncoder().encode(completed([output("done")]).map(frame).join(""));
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); } }), { headers: { "content-type": "text/event-stream" } }); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString() });
	try {
		const turn = agent.runTurn("hello");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const consume = (async () => { for await (const _event of turn) { } return turn.result; })();
		const result = await Promise.race([consume, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OpenAI terminal waited for EOF")), 1000); })]).finally(() => clearTimeout(timer));
		expect(result.status).toBe("success");
	} finally { await agent.dispose(); server.stop(true); }
});

test("OpenAI function call and reasoning metadata survive JSONL resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-openai-replay-"));
	const path = join(directory, "session.jsonl");
	const requests: Record<string, unknown>[] = [];
	const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: '{"city":"Paris"}', status: "completed" };
	const reasoning = { type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-reasoning", summary: [] };
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as Record<string, unknown>;
		requests.push(body);
		return sse(requests.length === 1 ? completed([reasoning, call]) : completed([output("finished")]));
	} });
	let effects = 0;
	const options = { ...base, baseUrl: server.url.toString(), cwd: directory, storage: await SessionStore.open(path, directory), tools: [{ name: "lookup", label: "Lookup", description: "Lookup a city", parameters: { type: "object" as const, properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }, async execute() { effects++; return { content: [{ type: "text" as const, text: "Paris is in France" }], details: null }; } }], permission: { rules: [{ tool: "lookup", argsPattern: "*", effect: "allow" as const }] } };
	try {
		const first = await createAgent(options);
		const turn = first.runTurn("lookup Paris");
		for await (const _event of turn) { }
		expect((await turn.result).status).toBe("success");
		expect(effects).toBe(1);
		const toolDefinition = (requests[0]?.tools as Array<Record<string, unknown>>)[0];
		expect(toolDefinition).toMatchObject({ type: "function", name: "lookup", strict: true });
		await first.dispose();
		const second = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		const next = second.runTurn("continue");
		for await (const _event of next) { }
		expect((await next.result).status).toBe("success");
		expect(effects).toBe(1);
		const replay = requests.at(-1)?.input as Array<Record<string, unknown>>;
		expect(replay).toContainEqual(expect.objectContaining({ type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-reasoning" }));
		expect(replay).toContainEqual(expect.objectContaining({ type: "function_call", id: "fc_fixture", call_id: "call_fixture" }));
		expect(replay).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_fixture" }));
		await second.dispose();
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("OpenAI streamed reasoning signature and tool arguments reach the next request", async () => {
	const requests: Record<string, unknown>[] = [];
	const call = { type: "function_call", id: "fc_stream", call_id: "call_stream", name: "lookup", arguments: '{"city":"Paris"}', status: "completed" };
	const reasoning = { type: "reasoning", id: "rs_stream", encrypted_content: "encrypted-stream", summary: [{ type: "summary_text", text: "checking" }] };
	const events = [
		{ type: "response.created", response: { id: "resp_stream", model: "gpt-4o-mini", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_stream", summary: [] } },
		{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "checking" },
		{ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Looking up" },
		{ type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
		{ type: "response.function_call_arguments.delta", item_id: "fc_stream", output_index: 2, delta: call.arguments },
		{ type: "response.function_call_arguments.done", item_id: "fc_stream", output_index: 2, arguments: call.arguments },
		{ type: "response.completed", response: { id: "resp_stream", model: "gpt-4o-mini", status: "completed", output: [reasoning, call], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
	];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json() as Record<string, unknown>);
		return sse(requests.length === 1 ? events : completed([output("finished")]));
	} });
	let effects = 0;
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), tools: [{ name: "lookup", label: "Lookup", description: "Lookup city", parameters: { type: "object" as const, properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }, async execute(args) { effects++; expect(args).toEqual({ city: "Paris" }); return { content: [{ type: "text" as const, text: "France" }], details: null }; } }], permission: { rules: [{ tool: "lookup", argsPattern: "*", effect: "allow" }] } });
	try {
		const turn = agent.runTurn("lookup Paris");
		for await (const _event of turn) { }
		expect((await turn.result).status).toBe("success");
		expect(effects).toBe(1);
		const input = requests[1]?.input as Array<Record<string, unknown>>;
		expect(input).toContainEqual(expect.objectContaining({ type: "reasoning", id: "rs_stream", encrypted_content: "encrypted-stream" }));
		expect(input).toContainEqual(expect.objectContaining({ type: "function_call", id: "fc_stream", call_id: "call_stream" }));
	} finally { await agent.dispose(); server.stop(true); }
});

test("OpenAI completed response with an unfinished tool call fails before execution", async () => {
	const events = [
		{ type: "response.created", response: { id: "resp_partial", model: "gpt-4o-mini", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "lookup", arguments: "" } },
		{ type: "response.completed", response: { id: "resp_partial", model: "gpt-4o-mini", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
	];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return sse(events); } });
	let effects = 0;
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), retry: { enabled: false }, tools: [{ name: "lookup", label: "Lookup", description: "Lookup city", parameters: { type: "object" as const, properties: {}, additionalProperties: false }, async execute() { effects++; return { content: [{ type: "text" as const, text: "ran" }], details: null }; } }], permission: { rules: [{ tool: "lookup", argsPattern: "*", effect: "allow" }] } });
	try {
		let reply: SessionMessage | undefined;
		const turn = agent.runTurn("lookup");
		for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
		expect(reply?.stopReason).toBe("error");
		expect(reply?.errorMessage).toContain("incomplete tool call");
		expect(effects).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});

test("OpenAI summary and transient retry use the same TanStack transport", async () => {
	const requests: Record<string, unknown>[] = [];
	const summary = JSON.stringify({ states: [], claims: [], taskChanged: false });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json() as Record<string, unknown>);
		if (requests.length === 1) return Response.json({ error: { type: "server_error", message: "service unavailable" } }, { status: 503 });
		return sse(completed([output(summary)]));
	} });
	const storage = new MemorySessionStorage([
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "old goal" }] },
		{ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "work ".repeat(1500) }] },
		{ role: "user", timestamp: 3, content: [{ type: "text", text: "continue" }] },
	]);
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), storage, context: { keepRecentTokens: 1 }, retry: { baseDelayMs: 0 } });
	try {
		expect((await agent.compact()).status).toBe("complete");
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ model: "gpt-4o-mini", store: false });
		expect(JSON.stringify(requests[0]?.instructions)).toContain("context summarization assistant");
	} finally { await agent.dispose(); server.stop(true); }
});

test("OpenAI complex schema stays non-strict and invalid tool input is rejected locally", async () => {
	const requests: Record<string, unknown>[] = [];
	const call = { type: "function_call", id: "fc_complex", call_id: "call_complex", name: "inspect", arguments: '{"value":3}', status: "completed" };
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json() as Record<string, unknown>);
		return sse(requests.length === 1 ? completed([call]) : completed([output("input rejected")]));
	} });
	let effects = 0;
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), tools: [{ name: "inspect", label: "Inspect", description: "Inspect value", parameters: { type: "object", properties: { value: { $ref: "#/$defs/value" } }, required: ["value"], additionalProperties: false, $defs: { value: { type: "string" } } }, async execute() { effects++; return { content: [{ type: "text" as const, text: "ok" }], details: null }; } }], permission: { rules: [{ tool: "inspect", argsPattern: "*", effect: "allow" }] } });
	try {
		const turn = agent.runTurn("inspect");
		for await (const _event of turn) { }
		expect((await turn.result).status).toBe("success");
		expect(effects).toBe(0);
		expect((requests[0]?.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "inspect", strict: false });
		expect(JSON.stringify(requests[1]?.input)).toContain("Validation failed for tool");
	} finally { await agent.dispose(); server.stop(true); }
});

test.each([429, 503])("OpenAI HTTP %i is a failed response", async status => {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ error: { type: "server_error", message: "service unavailable" } }, { status }); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), retry: { enabled: false } });
	try {
		let reply: SessionMessage | undefined;
		const turn = agent.runTurn("hello");
		for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
		expect(reply?.stopReason).toBe("error");
		expect(reply?.errorMessage).toContain(String(status));
	} finally { await agent.dispose(); server.stop(true); }
});

test("OpenAI request cancellation reaches the stream", async () => {
	const bytes = new TextEncoder().encode([
		{ type: "response.created", response: { id: "resp_fixture", model: "gpt-4o-mini", status: "in_progress" } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "working" },
	].map(frame).join(""));
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); } }), { headers: { "content-type": "text/event-stream" } }); } });
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), retry: { enabled: false } });
	try {
		let reply: SessionMessage | undefined;
		const turn = agent.runTurn("hello");
		for await (const event of turn) {
			if (event.type === "message_delta") agent.abort();
			if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
		}
		expect(reply?.stopReason).toBe("aborted");
	} finally { await agent.dispose(); server.stop(true); }
});

test.each(["{bad", "3", "[]"])("OpenAI invalid function arguments %s cannot execute an empty-object tool", async rawArguments => {
	const call = { type: "function_call", id: "fc_bad", call_id: "call_bad", name: "optional", arguments: rawArguments, status: "completed" };
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return sse(completed(++requests === 1 ? [call] : [output("done")])); } });
	let effects = 0;
	const agent = await createAgent({ ...base, baseUrl: server.url.toString(), retry: { enabled: false }, tools: [{ name: "optional", label: "Optional", description: "Optional input", parameters: { type: "object" as const, properties: {}, additionalProperties: false }, async execute() { effects++; return { content: [{ type: "text" as const, text: "ran" }], details: null }; } }], permission: { rules: [{ tool: "optional", argsPattern: "*", effect: "allow" }] } });
	try {
		let reply: SessionMessage | undefined;
		const turn = agent.runTurn("hello");
		for await (const event of turn) if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
		expect(reply?.stopReason).toBe("error");
		expect(effects).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});
