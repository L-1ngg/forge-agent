import { expect, test } from "bun:test";
import { createPiPort } from "../src/pi-port.ts";
import type { SessionMessage } from "@forge-agent/protocol";

for (const terminal of ["completed", "incomplete", "failed", "missing"] as const) {
	test(`Responses ${terminal} preserves stop semantics without waiting for HTTP EOF`, async () => {
		const item = { type: "message", id: "msg_terminal", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello!", annotations: [] }] };
		const events: unknown[] = [
			{ type: "response.created", response: { id: "resp_terminal" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello!" },
			{ type: "response.output_item.done", output_index: 0, item },
		];
		if (terminal !== "missing") events.push({
			type: `response.${terminal}`,
			response: {
				id: "resp_terminal", status: terminal, output: [item],
				usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
				...(terminal === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
				...(terminal === "failed" ? { error: { code: "server_error", message: "test failure" } } : {}),
			},
		});
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			fetch() {
				return new Response(new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
						if (terminal === "missing") controller.close();
					},
				}), { headers: { "content-type": "text/event-stream" } });
			},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const port = await createPiPort({ provider: "xai", model: "grok-4.6", apiKey: "test-local-key", baseUrl: server.url.toString(), cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off" });
			timer = setTimeout(() => port.abort(), 1000);
			let reply: SessionMessage | undefined;
			for await (const event of port.runTurn("hello")) {
				if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
			}
			expect(reply?.stopReason).toBe(terminal === "completed" ? "stop" : terminal === "incomplete" ? "length" : "error");
			if (terminal === "completed" || terminal === "incomplete") {
				expect(reply?.content).toContainEqual(expect.objectContaining({ type: "text", text: "Hello!" }));
				expect(reply?.usage).toMatchObject({ input: 3, output: 2 });
			} else {
				expect(reply?.errorMessage).toContain(terminal === "failed" ? "test failure" : "before a terminal response event");
			}
		} finally {
			clearTimeout(timer);
			server.stop(true);
		}
	});
}
