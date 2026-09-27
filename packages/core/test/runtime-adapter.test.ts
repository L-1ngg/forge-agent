import { expect, test } from "bun:test";
import type { TextOptions } from "@tanstack/ai";
import { createAgent, MemorySessionStorage, type Model, type Agent } from "@forge-agent/core/sdk";
import { sessionMessages } from "../src/session-storage.ts";
import { SUMMARY_SYSTEM } from "../src/context/compaction.ts";
import { gate, modelResponse } from "./helpers/model-response.ts";
import { replyAdapter, systemText, type NativeReply } from "./helpers/native-reply.ts";

const model: Model = {
	id: "host-model", name: "Host model", api: "faux", provider: "host-provider", baseUrl: "https://unused.invalid",
	reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const settings = { cwd: process.cwd(), systemPrompt: "host instructions", context: { enabled: false, keepRecentTokens: 1 } };
function answer(text = "host answer", patch: Partial<NativeReply> = {}): NativeReply {
	return { text, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 }, ...patch };
}
async function run(agent: Agent, input = "task") {
	const turn = agent.runTurn(input);
	for await (const _event of turn) { }
	return turn.result;
}
function history() {
	return new MemorySessionStorage([
		{ role: "user", content: [{ type: "text", text: "old goal ".repeat(100) }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "old answer ".repeat(1000) }], timestamp: 2, stopReason: "stop" },
		{ role: "user", content: [{ type: "text", text: "recent" }], timestamp: 3 },
	]);
}

test("SDK uses a native TanStack adapter with the request snapshot and durable history", async () => {
	const requests: TextOptions[] = []; const storage = new MemorySessionStorage();
	const adapter = replyAdapter(model, request => { requests.push(request); return answer("native answer"); });
	const agent = await createAgent({ ...settings, model, adapter, storage, thinkingLevel: "low", maxTokens: 321 });
	try {
		expect(await run(agent)).toEqual({ status: "success" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ model: model.id, modelOptions: { max_output_tokens: 321, reasoning: { effort: "low" } } });
		expect(requests[0]?.request?.signal).toBeInstanceOf(AbortSignal);
		expect(systemText(requests[0]!)).toBe("host instructions");
		expect(JSON.stringify(await storage.load())).toContain("native answer");
	} finally { await agent.dispose(); }
});

test("SDK async native adapter runs unknown models through tool policy, persistence and continuation", async () => {
	const calls: TextOptions[] = []; const effects: string[] = []; const hooks: string[] = [];
	const storage = new MemorySessionStorage();
	const adapter = replyAdapter(model, async request => {
		calls.push(request);
		return answer("done", calls.length === 1 ? { toolCalls: ["allow", "deny"].map(id => ({ id, name: "work", arguments: { value: id } })) } : {});
	});
	const agent = await createAgent({
		...settings, model, adapter, storage, thinkingLevel: "low", maxTokens: 321,
		permission: { hooks: [{ evaluate: call => call.id === "deny" ? { kind: "deny", source: "hook", reason: "blocked by policy" } : { kind: "allow", source: "hook" } }] },
		toolHooks: { beforeToolCall: async ({ toolCall }) => { hooks.push(toolCall.id); return undefined; } },
		tools: [{ name: "work", label: "Work", description: "work", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String(Reflect.get(args, "value"))); return { content: [{ type: "text", text: "tool output" }], details: { privateDetail: "display only" } }; } }],
	});
	try {
		expect(await run(agent)).toEqual({ status: "success" });
		expect(calls).toHaveLength(2); expect(effects).toEqual(["allow"]); expect(hooks).toEqual(["allow", "deny"]);
		expect(calls[0]).toMatchObject({ model: model.id, modelOptions: { max_output_tokens: 321, reasoning: { effort: "low" } } });
		expect(calls[0]?.request?.signal).toBeInstanceOf(AbortSignal);
		expect(systemText(calls[0]!)).toBe("host instructions");
		expect(calls[1]?.messages.filter(message => message.role === "tool").map(message => message.content)).toEqual([
			[{ type: "text", content: "tool output" }], [{ type: "text", content: "blocked by policy" }],
		]);
		const saved = sessionMessages(await storage.load());
		expect(saved.filter(message => message.role === "toolResult")).toHaveLength(2);
		expect(saved.find(message => message.toolCallId === "allow")?.details).toEqual({ privateDetail: "display only" });
		expect(saved.at(-1)).toMatchObject({ provider: model.provider, model: model.id, stopReason: "stop" });
	} finally { await agent.dispose(); }
});

test("SDK summary awaits the same async adapter and defers its replacement until compaction ends", async () => {
	const entered = gate(); const release = gate(); const calls: Array<{ request: TextOptions; transport: string }> = [];
	const storage = history();
	const oldAdapter = replyAdapter(model, async request => {
		calls.push({ request, transport: "old" });
		if (systemText(request) === SUMMARY_SYSTEM) { entered.resolve(); await release.promise; }
		return answer(JSON.stringify({ states: [], claims: [], taskChanged: false }));
	});
	const changedModel = { ...model, id: "next-model" };
	const nextAdapter = replyAdapter(changedModel, request => { calls.push({ request, transport: "new" }); return answer(); });
	const agent = await createAgent({ ...settings, model, adapter: oldAdapter, storage, thinkingLevel: "low" });
	const compacting = agent.compact();
	try {
		await entered.promise;
		const update = await agent.updateConfiguration({ model: changedModel, adapter: nextAdapter });
		let applied = false; void update.applied.then(() => { applied = true; }); await Promise.resolve();
		expect(applied).toBe(false); expect(calls).toHaveLength(1);
		expect(calls[0]?.request.modelOptions).toMatchObject({ reasoning: { effort: "low" } });
		expect(calls[0]?.request.request?.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.request.modelOptions?.max_output_tokens).toBeGreaterThan(0);
		expect(calls[0]?.request.tools ?? []).toEqual([]);
		release.resolve(); expect(await compacting).toMatchObject({ status: "complete" });
		expect((await storage.load()).entries.some(entry => entry.type === "compaction")).toBe(true);
		expect(await update.applied).toMatchObject({ status: "applied" });
		expect(await run(agent)).toEqual({ status: "success" });
		expect(calls.at(-1)).toMatchObject({ transport: "new", request: { model: "next-model" } });
	} finally { release.resolve(); await compacting; await agent.dispose(); }
});

test("SDK snapshots custom model metadata and switches adapter only after the active tool batch", async () => {
	const entered = gate(); const release = gate(); const calls: string[] = [];
	const selected = structuredClone(model);
	const initial = replyAdapter(selected, request => { calls.push(`old:${request.model}`); return answer("", { toolCalls: [{ id: "work-1", name: "work", arguments: {} }] }); });
	const creating = createAgent({
		...settings, model: selected, adapter: initial,
		transformContext: context => { expect(context.model.cost.input).toBe(0); return context.messages; },
		permission: { rules: [{ tool: "work", argsPattern: "*", effect: "allow" }] },
		tools: [{ name: "work", label: "Work", description: "work", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute() { entered.resolve(); await release.promise; return { content: [], details: {} }; } }],
	});
	selected.id = "mutated initial"; selected.cost.input = 999;
	const agent = await creating; const running = run(agent);
	try {
		await entered.promise;
		const next = { ...model, id: "replacement" };
		const updating = agent.updateConfiguration({ model: next, adapter: replyAdapter(next, request => { calls.push(`new:${request.model}`); return answer(); }) });
		next.id = "mutated update";
		const update = await updating;
		let applied = false; void update.applied.then(() => { applied = true; }); await Promise.resolve();
		expect(applied).toBe(false); expect(calls).toEqual(["old:host-model"]);
		release.resolve(); expect(await running).toEqual({ status: "success" });
		expect(await update.applied).toMatchObject({ status: "applied" }); expect(calls).toEqual(["old:host-model", "new:replacement"]);
		await expect(agent.updateConfiguration({ adapter: null })).rejects.toThrow("model object requires adapter");
		await expect(agent.updateConfiguration({ model: { ...model, contextWindow: 0 } })).rejects.toThrow("Invalid model metadata");
		expect(await run(agent)).toEqual({ status: "success" }); expect(calls.at(-1)).toBe("new:replacement");
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("SDK catalog model accepts an injected adapter without auth and can restore the built-in adapter", async () => {
	let custom = 0; let http = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { http++; return modelResponse(); } });
	const agent = await createAgent({ ...settings, provider: "anthropic", model: "claude-sonnet-4-5", adapter: replyAdapter("claude-sonnet-4-5", () => { custom++; return answer(); }) });
	try {
		expect(await run(agent)).toEqual({ status: "success" }); expect(custom).toBe(1); expect(http).toBe(0);
		const receipt = await agent.updateConfiguration({ adapter: null, apiKey: "local-fixture", baseUrl: server.url.toString() });
		expect(await receipt.applied).toMatchObject({ status: "applied" });
		expect(await run(agent)).toEqual({ status: "success" }); expect(custom).toBe(1); expect(http).toBe(1);
	} finally { await agent.dispose(); server.stop(true); }
});

test("SDK native adapter error events retry through the same transport and preserve one input", async () => {
	let requests = 0; const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...settings, model, storage, retry: { baseDelayMs: 0 }, adapter: replyAdapter(model, async () => {
		requests++; return answer("", requests === 1 ? { error: { message: "503 service unavailable" } } : {});
	}) });
	try {
		expect(await run(agent)).toEqual({ status: "success" }); expect(requests).toBe(2);
		const saved = sessionMessages(await storage.load());
		expect(saved.filter(message => message.role === "user")).toHaveLength(1);
		expect(saved.some(message => message.stopReason === "error")).toBe(true);
	} finally { await agent.dispose(); }
});

for (const summary of [false, true]) test(`SDK cancels asynchronous adapter preparation before its first chunk; summary=${summary}`, async () => {
	const entered = gate(); const storage = summary ? history() : new MemorySessionStorage();
	let signal: AbortSignal | undefined;
	const agent = await createAgent({ ...settings, model, storage, adapter: replyAdapter(model, async request => {
		signal = request.request?.signal ?? undefined;
		if (!signal) throw new Error("Missing signal");
		entered.resolve();
		await new Promise<void>(resolve => { if (signal!.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); });
		return { error: { message: "canceled", code: "aborted" } };
	}) });
	const running = summary ? agent.compact() : run(agent);
	try {
		await entered.promise; agent.abort(); await running; await agent.waitForIdle();
		expect(signal?.aborted).toBe(true);
		if (summary) { expect(await running).toMatchObject({ status: "error" }); expect((await storage.load()).entries.some(entry => entry.type === "compaction")).toBe(false); }
		else expect(await running).toEqual({ status: "aborted" });
	} finally { await agent.dispose(); }
});

test("SDK rejects incomplete selections and removed streamFn before invoking an adapter", async () => {
	await expect(createAgent({ ...settings, model })).rejects.toThrow("model object requires adapter");
	await expect(createAgent({ ...settings, model: "claude-sonnet-4-5" })).rejects.toThrow("catalog model requires provider");
	await expect(createAgent({ ...settings, provider: "other", model, adapter: replyAdapter(model, () => answer()) })).rejects.toThrow("provider must match");
	// @ts-expect-error Removed StreamFn must fail loudly for JavaScript callers too.
	await expect(createAgent({ ...settings, model, adapter: replyAdapter(model, () => answer()), streamFn: () => { throw new Error("must not run"); } })).rejects.toThrow("streamFn");
});
