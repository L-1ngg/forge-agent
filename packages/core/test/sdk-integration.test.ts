import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent, MemorySessionStorage, type Agent } from "@myh/core/sdk";
import { response, type SessionEvent } from "@myh/protocol";

interface ModelRequest {
	system: unknown;
	tools: Array<{ name: string }>;
	messages: Array<{ role: string; content: Array<{ type: string; text?: string; name?: string }> }>;
}

function modelResponse(toolCall: boolean): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: toolCall ? { type: "tool_use", id: "same-call", name: "capture", input: {} } : { type: "text", text: "done" } },
		...(toolCall ? [{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":"local"}' } }] : []),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("public SDK drives isolated HTTP tool loops without implicit config or file storage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "myh-sdk-http-"));
	const requests: ModelRequest[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as ModelRequest;
		requests.push(body);
		return modelResponse(!body.messages.some((message) => message.content.some((content) => content.type === "tool_result")));
	} });
	const agents: Agent[] = [];
	try {
		await mkdir(join(directory, ".myh"));
		await writeFile(join(directory, ".myh/config.json"), "invalid JSON that must never be loaded");
		const executed: string[] = [];
		const firstStorage = new MemorySessionStorage();
		const secondStorage = new MemorySessionStorage();
		for (const [name, storage] of [["first", firstStorage], ["second", secondStorage]] as const) {
			agents.push(await createAgent({
				provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test-key", baseUrl: server.url.toString(),
				cwd: directory, systemPrompt: `host-${name}`, storage,
				tools: [{ name: "capture", label: "Capture", description: "Return the host name.",
					parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
					async execute(input) { expect(input).toEqual({ value: "local" }); executed.push(name); return { ok: true, value: name }; },
				}],
			}));
		}
		const collect = async (agent: Agent, input: string): Promise<SessionEvent[]> => {
			const events: SessionEvent[] = [];
			for await (const event of agent.runTurn(input)) events.push(event);
			return events;
		};
		const firstRun = collect(agents[0]!, "first-prompt");
		const secondRun = collect(agents[1]!, "second-prompt");
		const firstRequest = await agents[0]!.requests[Symbol.asyncIterator]().next();
		const secondRequest = await agents[1]!.requests[Symbol.asyncIterator]().next();
		if (firstRequest.done || secondRequest.done) throw new Error("Expected separate permission requests");
		expect(executed).toEqual([]);
		expect(firstRequest.value.kind).toBe("permission");
		expect(secondRequest.value.kind).toBe("permission");
		agents[0]!.respond(response(firstRequest.value.id, { decision: "deny", reason: "first denied" }));
		agents[1]!.respond(response(secondRequest.value.id, { decision: "allow_once" }));
		await firstRun;
		const secondEvents = await secondRun;
		expect(executed).toEqual(["second"]);
		expect(secondEvents.at(-1)?.type).toBe("agent_end");
		expect((await secondStorage.load()).at(-1)?.stopReason).toBe("stop");
		expect(JSON.stringify(await secondStorage.load())).not.toContain("first-prompt");
		expect(JSON.stringify(await firstStorage.load())).not.toContain("second-prompt");
		expect(requests).toHaveLength(3);
		for (const request of requests) expect(request.tools.map((tool) => tool.name)).toEqual(["capture"]);
		expect(JSON.stringify(requests[0]!.system)).toContain("host-");
		expect(await readdir(directory)).toEqual([".myh"]);
		expect(await readdir(join(directory, ".myh"))).toEqual(["config.json"]);
	} finally {
		for (const agent of agents) await agent.dispose();
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});
