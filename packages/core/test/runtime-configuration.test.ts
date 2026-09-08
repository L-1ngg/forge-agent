import { expect, test } from "bun:test";
import { createAgent } from "@forge-agent/core/sdk";
import { modelResponse, gate } from "./helpers/model-response.ts";
const settings = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", systemPrompt: "old prompt", cwd: process.cwd() };

test("SDK accepts configuration during tools and applies it after the complete batch", async () => {
	const started = gate(); const release = gate(); const nextRequest = gate(); const finish = gate();
	const effects: string[] = []; const requests: Array<{ system: unknown; tools: unknown; model: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			requests.push(await request.json() as typeof requests[number]);
			if (requests.length === 1) return modelResponse(["a", "b"].map(id => ({ id, name: "work", arguments: {} })));
			nextRequest.resolve(); await finish.promise; return modelResponse();
		}
	});
	const parameters = { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "work", label: "Old", description: "old", parameters, async execute(_args, context) { effects.push(`old:${context.toolCallId}`); started.resolve(); await release.promise; return { content: [{ type: "text", text: "old effect" }], details: {} }; } }],
	});
	const running = (async () => { for await (const _event of agent.runTurn("work")) { } })();
	try {
		await started.promise;
		const update = await agent.updateConfiguration({ systemPrompt: "new prompt", tools: [{ name: "replacement", label: "New", description: "new", parameters, async execute() { effects.push("new"); return { content: [], details: {} }; } }] });
		expect(update.accepted).toBe(true);
		let applied = false; void update.applied.then(() => { applied = true; });
		await Promise.resolve(); expect(applied).toBe(false); expect(requests).toHaveLength(1);
		release.resolve(); await nextRequest.promise;
		expect(await update.applied).toMatchObject({ status: "applied" });
		expect(effects).toEqual(["old:a", "old:b"]);
		expect(JSON.stringify(requests[1]?.system)).toContain("new prompt");
		expect(JSON.stringify(requests[1]?.tools)).toContain("replacement");
		// Last-call counters remain historical; only the current context anchor expires.
		expect(agent.getUsage()?.contextEstimated).toBe(true);
		expect(agent.getUsage()?.contextTokens).not.toBe(15);
		finish.resolve(); await running;
		const idle = await agent.updateConfiguration({ systemPrompt: "idle prompt" });
		expect(await idle.applied).toMatchObject({ status: "applied" }); expect(requests).toHaveLength(2);
		await expect(agent.updateConfiguration({ model: "not-a-model" })).rejects.toThrow("Unknown model");
	} finally { release.resolve(); finish.resolve(); await running; await agent.dispose(); server.stop(true); }
});

for (const dispose of [false, true]) test(`SDK defers model and reasoning changes during a response; dispose=${dispose}`, async () => {
	const started = gate(); const release = gate();
	const requests: Array<{ model: string; thinking?: unknown; system: unknown }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			requests.push(await request.json() as typeof requests[number]);
			if (requests.length === 1) { started.resolve(); await release.promise; }
			return modelResponse();
		}
	});
	const agent = await createAgent({ ...settings, baseUrl: server.url.toString() });
	const turn = agent.runTurn("first");
	const run = (async () => { for await (const _event of turn) { } })();
	try {
		await started.promise;
		const update = await agent.updateConfiguration({ model: "claude-haiku-4-5", thinkingLevel: "low", systemPrompt: "replacement" });
		let applied = false; void update.applied.then(() => { applied = true; });
		await Promise.resolve(); expect(applied).toBe(false);
		if (dispose) {
			const closing = agent.dispose(); release.resolve(); await closing; await run;
			expect(await update.applied).toMatchObject({ status: "canceled" });
			expect(await turn.result).toEqual({ status: "aborted" });
		} else {
			release.resolve(); await run;
			expect(await update.applied).toMatchObject({ status: "applied" }); expect(requests).toHaveLength(1);
			await expect(agent.updateConfiguration({ model: "missing", systemPrompt: "must not leak" })).rejects.toThrow("Unknown model");
			for await (const _event of agent.runTurn("second")) { }
			expect(requests[0]?.model).toBe("claude-sonnet-4-5"); expect(requests[0]?.thinking).toEqual({ type: "disabled" });
			expect(requests[1]?.model).toBe("claude-haiku-4-5"); expect(requests[1]?.thinking).toMatchObject({ type: "enabled" });
			expect(JSON.stringify(requests[1]?.system)).toContain("replacement");
			expect(JSON.stringify(requests[1])).not.toContain("must not leak");
		}
	} finally { release.resolve(); await run; await agent.dispose(); server.stop(true); }
});

test("SDK configuration waits for manual summary and applies to the following task", async () => {
	const { MemorySessionStorage } = await import("@forge-agent/core/sdk");
	const storage = new MemorySessionStorage([
		{ role: "user", content: [{ type: "text", text: "old goal ".repeat(100) }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2, stopReason: "stop" },
		{ role: "user", content: [{ type: "text", text: "recent" }], timestamp: 3 },
	]);
	const started = gate(); const release = gate();
	const requests: Array<{ model: string; system: unknown }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			requests.push(await request.json() as typeof requests[number]);
			if (requests.length === 1) { started.resolve(); await release.promise; }
			return modelResponse();
		}
	});
	const agent = await createAgent({ ...settings, baseUrl: server.url.toString(), storage, context: { enabled: false, keepRecentTokens: 1 } });
	const compact = agent.compact();
	try {
		await started.promise;
		const update = await agent.updateConfiguration({ model: "claude-haiku-4-5", systemPrompt: "after summary" });
		let applied = false; void update.applied.then(() => { applied = true; }); await Promise.resolve(); expect(applied).toBe(false);
		release.resolve(); expect(await compact).toMatchObject({ status: "complete" });
		expect(await update.applied).toMatchObject({ status: "applied" }); expect(requests).toHaveLength(1);
		for await (const _event of agent.continue()) { }
		expect(requests[1]?.model).toBe("claude-haiku-4-5"); expect(JSON.stringify(requests[1]?.system)).toContain("after summary");
	} finally { release.resolve(); await compact; await agent.dispose(); server.stop(true); }
});
