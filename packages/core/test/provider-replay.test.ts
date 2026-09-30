import { createAgent } from "../src/sdk.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/index.ts";

test("provider thinking signatures survive session storage and replay over HTTP", async () => {
	const requests: Array<{ messages: Array<{ role: string; content: unknown[] }> }> = [];
	const model = "claude-sonnet-4-5";
	const events = [
		{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "test-signature" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "test-opaque-payload" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "reply" } },
		{ type: "content_block_stop", index: 2 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			requests.push(await request.json());
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "forge-agent-replay-"));
	const agents: Awaited<ReturnType<typeof createAgent>>[] = [];
	try {
		const path = join(directory, "session.jsonl");
		const store = await SessionStore.open(path, directory);
		const options = { provider: "anthropic", model, apiKey: "test-local-key", baseUrl: server.url.toString(), cwd: directory, systemPrompt: "test", thinkingLevel: "low" as const };
		const first = await createAgent({ ...options, storage: store });
		agents.push(first);
		for await (const event of first.runTurn("first")) {
			if (event.type === "message_end") expect(event.message.errorMessage).toBeUndefined();
		}
		const reopened = await SessionStore.open(path, directory);
		const second = await createAgent({ ...options, storage: reopened });
		agents.push(second);
		for await (const event of second.runTurn("second")) {
			if (event.type === "message_end") expect(event.message.errorMessage).toBeUndefined();
		}
		expect(requests).toHaveLength(2);
		const replayed = requests[1]!.messages.find((message) => message.role === "assistant")!.content;
		expect(replayed).toContainEqual({ type: "thinking", thinking: "reason", signature: "test-signature" });
		expect(replayed).toContainEqual({ type: "redacted_thinking", data: "test-opaque-payload" });
	} finally {
		await Promise.all(agents.map(agent => agent.dispose()));
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});

test("Gemini tool signature survives JSONL reopen without replaying its effect", async () => {
	const requests: unknown[] = [];
	const reply = (value: unknown) => new Response(`data: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		if (requests.length === 1) return reply({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-fixture", name: "echo", args: { value: "once" } }, thoughtSignature: "saved-signature" }] }, finishReason: "STOP" }] });
		return reply({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] });
	} });
	const directory = await mkdtemp(join(tmpdir(), "forge-gemini-replay-"));
	let executions = 0;
	try {
		const path = join(directory, "session.jsonl");
		const options = { provider: "google", model: "gemini-2.5-flash", apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: directory, systemPrompt: "test", thinkingLevel: "off" as const,
			context: { enabled: false }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow" as const, source: "hook" as const }) }] },
			tools: [{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"], additionalProperties: false as const }, async execute() { executions++; return { content: [{ type: "text" as const, text: "once" }], details: {} }; } }],
		};
		const first = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		try {
			const turn = first.runTurn("first");
			for await (const _event of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
		} finally { await first.dispose(); }
		const reopened = await createAgent({ ...options, storage: await SessionStore.open(path, directory) });
		try {
			const turn = reopened.runTurn("second");
			for await (const _event of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
		} finally { await reopened.dispose(); }
		expect(executions).toBe(1);
		expect(requests).toHaveLength(3);
		expect(JSON.stringify(requests[2])).toContain('"thoughtSignature":"saved-signature"');
		expect(JSON.stringify(requests[2])).toContain("functionResponse");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Gemini tool continuation survives compaction and JSONL reopen without repeating the tool", async () => {
	const requests: unknown[] = [];
	const reply = (value: unknown) => new Response(`data: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body: unknown = await request.json();
		requests.push(body);
		if (requests.length === 2) return reply({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-fixture", name: "echo", args: { value: "once" } }, thoughtSignature: "saved-signature" }] }, finishReason: "STOP" }] });
		if (JSON.stringify(body).includes("context summarization assistant")) return reply({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ states: [], claims: [], taskChanged: false }) }] }, finishReason: "STOP" }] });
		return reply({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] });
	} });
	const directory = await mkdtemp(join(tmpdir(), "forge-gemini-compact-replay-"));
	let executions = 0;
	try {
		const path = join(directory, "session.jsonl");
		const options = { provider: "google", model: "gemini-2.5-flash", apiKey: "fixture-key", baseUrl: server.url.toString(), cwd: directory, systemPrompt: "test", thinkingLevel: "off" as const,
			context: { keepRecentTokens: 2000 }, retry: { enabled: false }, permission: { hooks: [{ evaluate: () => ({ kind: "allow" as const, source: "hook" as const }) }] },
			tools: [{ name: "echo", label: "Echo", description: "Echo a value", parameters: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"], additionalProperties: false as const }, async execute() { executions++; return { content: [{ type: "text" as const, text: "once" }], details: {} }; } }],
		};
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
		expect(requests.some(body => JSON.stringify(body).includes("context summarization assistant"))).toBe(true);
		const next = JSON.stringify(requests.at(-1));
		expect(next).toContain('"thoughtSignature":"saved-signature"');
		expect(next).toContain("functionResponse");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
