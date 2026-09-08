import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage } from "@forge-agent/core/sdk";
import { sessionMessages } from "../src/session-storage.ts";
import { modelResponse } from "./helpers/model-response.ts";
const settings = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", systemPrompt: "task-system", cwd: process.cwd() };
const history = [{ role: "user" as const, content: [{ type: "text" as const, text: "old goal ".repeat(100) }], timestamp: 1 }, { role: "assistant" as const, content: [{ type: "text" as const, text: "old work" }], timestamp: 2, stopReason: "stop" as const }, { role: "user" as const, content: [{ type: "text" as const, text: "recent" }], timestamp: 3 }];

test("SDK manually compacts disabled automatic context and reopens without erasing history", async () => {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	const storage = new MemorySessionStorage(history);
	const options = { ...settings, baseUrl: server.url.toString(), storage, context: { enabled: false, keepRecentTokens: 1 } };
	const agent = await createAgent(options);
	try {
		const result = await agent.compact("keep decisions");
		expect(result.status).toBe("complete"); expect(requests).toHaveLength(1); expect(requests[0]).toContain("keep decisions");
		expect(sessionMessages(await storage.load())).toEqual(history);
		expect(agent.getUsage()?.contextEstimated).toBe(true);
		expect((await agent.compact()).status).toBe("skipped"); expect(requests).toHaveLength(1);
		await agent.dispose();
		const reopened = await createAgent(options);
		try { for await (const _event of reopened.continue()) { } expect(requests[1]).toContain("saved answer"); expect(requests[1]).not.toContain("old goal old goal"); }
		finally { await reopened.dispose(); }
	} finally { await agent.dispose(); server.stop(true); }
});

for (const mode of ["threshold", "length", "overflow", "disabled"] as const) test(`SDK automatic context and bounded recovery: ${mode}`, async () => {
	let tasks = 0; let summaries = 0; let effects = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			const body = await request.json() as { system: unknown };
			if (!JSON.stringify(body.system).includes("task-system")) { summaries++; return modelResponse(); }
			tasks++;
			if (mode === "overflow") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }), { status: 400 });
			if ((mode === "length" || mode === "disabled") && tasks === 1) return modelResponse([{ id: "truncated", name: "work", arguments: {} }], "max_tokens");
			return modelResponse();
		}
	});
	const storage = new MemorySessionStorage(history);
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), storage, contextWindow: mode === "threshold" ? 100 : 100000,
		context: { enabled: mode !== "disabled", reserveTokens: 20, keepRecentTokens: 1 },
		tools: [{ name: "work", label: "Work", description: "work", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { effects++; return { content: [], details: {} }; } }],
	});
	try {
		const events = [];
		for await (const event of agent.runTurn("continue")) events.push(event);
		expect(effects).toBe(0);
		expect(sessionMessages(await storage.load()).filter(message => message.role === "toolResult")).toEqual([]);
		expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(tasks).toBe(mode === "length" || mode === "overflow" ? 2 : 1);
		expect(summaries).toBe(mode === "disabled" ? 0 : mode === "threshold" ? 1 : 2);
		expect(events.filter(event => event.type === "recovery")).toHaveLength(mode === "length" || mode === "overflow" ? 1 : 0);
	} finally { await agent.dispose(); server.stop(true); }
});
