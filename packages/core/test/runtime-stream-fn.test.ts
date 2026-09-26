import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage, type Model, type StreamFn, type Agent } from "@forge-agent/core/sdk";
import { EventStream } from "../src/model-stream.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../src/model-types.ts";
import { sessionMessages } from "../src/session-storage.ts";
import { SUMMARY_SYSTEM } from "../src/context/compaction.ts";
import { gate, modelResponse } from "./helpers/model-response.ts";

const model: Model<string> = {
	id: "host-model", name: "Host model", api: "host-stream", provider: "host-provider", baseUrl: "https://unused.invalid",
	reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const settings = { cwd: process.cwd(), systemPrompt: "host instructions", context: { enabled: false, keepRecentTokens: 1 } };
type Call = { model: Model<string>; context: Parameters<StreamFn>[1]; options: Parameters<StreamFn>[2] };

function answer(selected: Model<string>, text = "host answer", patch: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
		content: [{ type: "text", text }], stopReason: "stop",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...patch,
	};
}
function streamResult(message: AssistantMessage) {
	if (message.stopReason === "pending") throw new Error("Expected a completed fixture response");
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		event => event.type === "done" || event.type === "error",
		event => { if (event.type === "done") return event.message; if (event.type === "error") return event.error; throw new Error("Expected terminal event"); },
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
	else stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
	return stream;
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

test("SDK async StreamFn runs unknown models through tool policy, persistence and continuation", async () => {
	const calls: Call[] = []; const effects: string[] = []; const hooks: string[] = [];
	const storage = new MemorySessionStorage();
	const streamFn: StreamFn = async (selected, context, options) => {
		calls.push({ model: structuredClone(selected), context, options });
		return streamResult(answer(selected, "done", calls.length === 1 ? {
			stopReason: "toolUse", content: ["allow", "deny"].map(id => ({ type: "toolCall", id, name: "work", arguments: { value: id } })),
		} : {}));
	};
	const agent = await createAgent({
		...settings, model, streamFn, storage, thinkingLevel: "low", apiKey: "host-key", sessionId: "host-session", maxTokens: 321,
		permission: { hooks: [{ evaluate: call => call.id === "deny" ? { kind: "deny", source: "hook", reason: "blocked by policy" } : { kind: "allow", source: "hook" } }] },
		toolHooks: { beforeToolCall: async ({ toolCall }) => { hooks.push(toolCall.id); return undefined; } },
		tools: [{ name: "work", label: "Work", description: "work", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String(Reflect.get(args, "value"))); return { content: [{ type: "text", text: "tool output" }], details: { privateDetail: "display only" } }; } }],
	});
	try {
		expect(await run(agent)).toEqual({ status: "success" });
		expect(calls).toHaveLength(2); expect(effects).toEqual(["allow"]); expect(hooks).toEqual(["allow", "deny"]);
		expect(calls[0]?.model).toEqual(model);
		expect(calls[0]?.options).toMatchObject({ apiKey: "host-key", sessionId: "host-session", maxTokens: 321, maxRetries: 0, reasoning: "low" });
		expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.context.systemPrompt).toBe("host instructions");
		expect(calls[1]?.context.messages.filter(message => message.role === "toolResult").map(message => message.content)).toEqual([
			[{ type: "text", text: "tool output" }], [{ type: "text", text: "blocked by policy" }],
		]);
		const saved = sessionMessages(await storage.load());
		expect(saved.filter(message => message.role === "toolResult")).toHaveLength(2);
		expect(saved.find(message => message.toolCallId === "allow")?.details).toEqual({ privateDetail: "display only" });
		expect(saved.at(-1)).toMatchObject({ provider: model.provider, model: model.id, stopReason: "stop" });
	} finally { await agent.dispose(); }
});

test("SDK summary awaits the same async StreamFn and defers its replacement until compaction ends", async () => {
	const entered = gate(); const release = gate(); const calls: Array<Call & { transport: string }> = [];
	const storage = history();
	const oldStream: StreamFn = async (selected, context, options) => {
		calls.push({ model: selected, context, options, transport: "old" });
		if (context.systemPrompt === SUMMARY_SYSTEM) { entered.resolve(); await release.promise; }
		return streamResult(answer(selected, JSON.stringify({ states: [], claims: [], taskChanged: false })));
	};
	const nextStream: StreamFn = (selected, context, options) => {
		calls.push({ model: selected, context, options, transport: "new" });
		return streamResult(answer(selected));
	};
	const agent = await createAgent({ ...settings, model, streamFn: oldStream, storage, apiKey: "old-key", sessionId: "shared", thinkingLevel: "low" });
	const compacting = agent.compact();
	try {
		await entered.promise;
		const changedModel = { ...model, id: "next-model" };
		const update = await agent.updateConfiguration({ model: changedModel, streamFn: nextStream, apiKey: "new-key" });
		let applied = false; void update.applied.then(() => { applied = true; }); await Promise.resolve();
		expect(applied).toBe(false); expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toMatchObject({ apiKey: "old-key", sessionId: "shared", cacheRetention: "none", maxRetries: 0, reasoning: "low" });
		expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.options?.maxTokens).toBeGreaterThan(0);
		release.resolve(); expect(await compacting).toMatchObject({ status: "complete" });
		expect((await storage.load()).entries.some(entry => entry.type === "compaction")).toBe(true);
		expect(await update.applied).toMatchObject({ status: "applied" });
		expect(await run(agent)).toEqual({ status: "success" });
		expect(calls.at(-1)).toMatchObject({ transport: "new", model: { id: "next-model" }, options: { apiKey: "new-key", sessionId: "shared" } });
	} finally { release.resolve(); await compacting; await agent.dispose(); }
});

test("SDK snapshots custom models and switches StreamFn only after the active tool batch", async () => {
	const entered = gate(); const release = gate(); const calls: string[] = [];
	const selected = structuredClone(model);
	const initial: StreamFn = current => {
		expect(current.cost.input).toBe(0);
		calls.push(`old:${current.id}`);
		return streamResult(answer(current, "", { stopReason: "toolUse", content: [{ type: "toolCall", id: "work-1", name: "work", arguments: {} }] }));
	};
	const creating = createAgent({
		...settings, model: selected, streamFn: initial,
		permission: { rules: [{ tool: "work", argsPattern: "*", effect: "allow" }] },
		tools: [{ name: "work", label: "Work", description: "work", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute() { entered.resolve(); await release.promise; return { content: [], details: {} }; } }],
	});
	selected.id = "mutated initial"; selected.cost.input = 999;
	const agent = await creating;
	const running = run(agent);
	try {
		await entered.promise;
		const next = { ...model, id: "replacement" };
		const updating = agent.updateConfiguration({ model: next, streamFn: current => { calls.push(`new:${current.id}`); return streamResult(answer(current)); } });
		next.id = "mutated update";
		const update = await updating;
		let applied = false; void update.applied.then(() => { applied = true; }); await Promise.resolve();
		expect(applied).toBe(false); expect(calls).toEqual(["old:host-model"]);
		release.resolve(); expect(await running).toEqual({ status: "success" });
		expect(await update.applied).toMatchObject({ status: "applied" }); expect(calls).toEqual(["old:host-model", "new:replacement"]);
		await expect(agent.updateConfiguration({ streamFn: null })).rejects.toThrow("model object requires streamFn");
		await expect(agent.updateConfiguration({ model: { ...model, contextWindow: 0 } })).rejects.toThrow("Invalid model metadata");
		expect(await run(agent)).toEqual({ status: "success" }); expect(calls.at(-1)).toBe("new:replacement");
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("SDK catalog model accepts an injected transport without auth and can restore the built-in transport", async () => {
	let custom = 0; let http = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { http++; return modelResponse(); } });
	const agent = await createAgent({ ...settings, provider: "anthropic", model: "claude-sonnet-4-5", streamFn: selected => { custom++; return streamResult(answer(selected)); } });
	try {
		expect(await run(agent)).toEqual({ status: "success" }); expect(custom).toBe(1); expect(http).toBe(0);
		const receipt = await agent.updateConfiguration({ streamFn: null, apiKey: "local-fixture", baseUrl: server.url.toString() });
		expect(await receipt.applied).toMatchObject({ status: "applied" });
		expect(await run(agent)).toEqual({ status: "success" }); expect(custom).toBe(1); expect(http).toBe(1);
	} finally { await agent.dispose(); server.stop(true); }
});

test("SDK StreamFn error events retry through the same transport and preserve one input", async () => {
	let requests = 0; const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...settings, model, storage, retry: { baseDelayMs: 0 }, streamFn: async selected => {
		requests++;
		return streamResult(answer(selected, "", requests === 1 ? { stopReason: "error", errorMessage: "503 service unavailable" } : {}));
	} });
	try {
		expect(await run(agent)).toEqual({ status: "success" }); expect(requests).toBe(2);
		const saved = sessionMessages(await storage.load());
		expect(saved.filter(message => message.role === "user")).toHaveLength(1);
		expect(saved.some(message => message.stopReason === "error")).toBe(true);
	} finally { await agent.dispose(); }
});

for (const summary of [false, true]) test(`SDK cancels an async StreamFn before stream creation; summary=${summary}`, async () => {
	const entered = gate(); const storage = summary ? history() : new MemorySessionStorage();
	let signal: AbortSignal | undefined;
	const agent = await createAgent({ ...settings, model, storage, streamFn: async (selected, _context, options) => {
		signal = options?.signal;
		if (!signal) throw new Error("Missing signal");
		entered.resolve();
		await new Promise<void>(resolve => { if (signal!.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); });
		return streamResult(answer(selected, "", { stopReason: "aborted", errorMessage: "canceled" }));
	} });
	const running = summary ? agent.compact() : run(agent);
	try {
		await entered.promise; agent.abort(); await running; await agent.waitForIdle();
		expect(signal?.aborted).toBe(true);
		if (summary) { expect(await running).toMatchObject({ status: "error" }); expect((await storage.load()).entries.some(entry => entry.type === "compaction")).toBe(false); }
		else expect(await running).toEqual({ status: "aborted" });
	} finally { await agent.dispose(); }
});

test("SDK rejects incomplete model selections before invoking a transport", async () => {
	await expect(createAgent({ ...settings, model })).rejects.toThrow("model object requires streamFn");
	await expect(createAgent({ ...settings, model: "claude-sonnet-4-5" })).rejects.toThrow("catalog model requires provider");
	await expect(createAgent({ ...settings, provider: "other", model, streamFn: selected => streamResult(answer(selected)) })).rejects.toThrow("provider must match");
});
