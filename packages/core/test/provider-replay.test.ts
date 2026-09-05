import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, createPiPort, SessionStore } from "../src/index.ts";

test("provider thinking signatures survive session storage and replay over HTTP", async () => {
	const requests: Array<{ messages: Array<{ role: string; content: unknown[] }> }> = [];
	const model = "claude-sonnet-4-5";
	const events = [
		{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "reason", signature: "test-signature" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "test-opaque-payload" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "text", text: "reply" } },
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
	const directory = await mkdtemp(join(tmpdir(), "myh-replay-"));
	try {
		const path = join(directory, "session.jsonl");
		const store = await SessionStore.open(path, directory);
		const options = { provider: "anthropic", model, apiKey: "test-local-key", baseUrl: server.url.toString(), cwd: directory, systemPrompt: "test", thinkingLevel: "low" as const };
		const first = new AgentRunner(await createPiPort(options), store);
		for await (const event of first.runTurn("first")) {
			if (event.type === "message_end") expect(event.message.errorMessage).toBeUndefined();
		}
		const reopened = await SessionStore.open(path, directory);
		const second = await createPiPort({ ...options, history: reopened.messages() });
		for await (const event of second.runTurn("second")) {
			if (event.type === "message_end") expect(event.message.errorMessage).toBeUndefined();
		}
		expect(requests).toHaveLength(2);
		const replayed = requests[1]!.messages.find((message) => message.role === "assistant")!.content;
		expect(replayed).toContainEqual({ type: "thinking", thinking: "reason", signature: "test-signature" });
		expect(replayed).toContainEqual({ type: "redacted_thinking", data: "test-opaque-payload" });
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});
