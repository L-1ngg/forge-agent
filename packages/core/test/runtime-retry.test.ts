import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage } from "@forge-agent/core/sdk";
import { sessionMessages } from "../src/session-storage.ts";
import { modelResponse } from "./helpers/model-response.ts";
const settings = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", systemPrompt: "retry", cwd: process.cwd() };
for (const cancel of [false, true]) test(`SDK transient retry preserves input and tool effects; cancel=${cancel}`, async () => {
	let requests = 0; let effects = 0;
	const bodies: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			bodies.push(await request.json()); requests++;
			if (requests === 1) return modelResponse([{ id: "once", name: "work", arguments: {} }]);
			if (requests === 2) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "temporarily overloaded" } }), { status: 529 });
			return modelResponse();
		}
	});
	const storage = new MemorySessionStorage();
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), storage, retry: { baseDelayMs: cancel ? 2000 : 0 },
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "work", label: "Work", description: "work", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { effects++; return { content: [{ type: "text", text: "tool done" }], details: {} }; } }],
	});
	try {
		const turn = agent.runTurn("exactly once"); const events = [];
		for await (const event of turn) { events.push(event); if (cancel && event.type === "retry" && event.phase === "scheduled") agent.abort(); }
		expect(effects).toBe(1); expect(requests).toBe(cancel ? 2 : 3);
		expect(await turn.result).toEqual({ status: cancel ? "aborted" : "success" });
		expect(sessionMessages(await storage.load()).filter(message => message.role === "user")).toHaveLength(1);
		expect(sessionMessages(await storage.load()).some(message => message.stopReason === "error")).toBe(true);
		if (!cancel) { expect(JSON.stringify(bodies[2])).toContain("tool done"); expect(JSON.stringify(bodies[2])).not.toContain("temporarily overloaded"); }
		expect(events.filter(event => event.type === "retry" && event.phase === "scheduled")).toHaveLength(1);
	} finally { await agent.dispose(); server.stop(true); }
});

test("SDK task retry uses three independent 2/4/8 second waits and resets for a new invocation", async () => {
	const { createScriptedSession } = await import("./helpers/scripted-session.ts");
	const waits: number[] = []; let calls = 0;
	const storage = new MemorySessionStorage();
	const session = createScriptedSession({
		contextWindow: 100000,
		async stream() { calls++; return { role: "assistant", content: [], timestamp: calls, stopReason: "error", errorMessage: "temporarily overloaded" }; },
		isRetryable: () => true,
		async wait(ms, signal) { signal.throwIfAborted(); waits.push(ms); },
		async execute() { throw new Error("No tools"); }, abortInteractions() { },
	});
	const agent = await createAgent({ ...settings, storage }, () => session);
	try {
		for (const input of ["first", "second"]) {
			const turn = agent.runTurn(input); const retries = [];
			for await (const event of turn) if (event.type === "retry") retries.push(event);
			expect(await turn.result).toEqual({ status: "error" });
			expect(retries.at(-1)).toMatchObject({ phase: "end", attempt: 3, outcome: "error" });
		}
		expect(calls).toBe(8); expect(waits).toEqual([2000, 4000, 8000, 2000, 4000, 8000]);
		expect(sessionMessages(await storage.load()).filter(message => message.role === "user")).toHaveLength(2);
	} finally { await agent.dispose(); }
});
