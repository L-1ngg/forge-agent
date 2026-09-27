import type { TextOptions } from "@tanstack/ai";
import { replyAdapter, systemText, type NativeReply } from "./helpers/native-reply.ts";
import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage, type AgentTurn, type CreateAgentOptions, type Model, type ShouldStopAfterTurnContext } from "@forge-agent/core/sdk";
import type { SessionEvent } from "@forge-agent/protocol";
import { sessionMessages } from "../src/session-storage.ts";
import { SUMMARY_SYSTEM } from "../src/context/compaction.ts";
import { gate } from "./helpers/model-response.ts";

const model: Model<string> = {
	id: "policy-model", name: "Policy model", api: "faux", provider: "host", baseUrl: "https://unused.invalid",
	reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192,
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
};
const defaults = { model, cwd: process.cwd(), systemPrompt: "policy test", context: { enabled: false, keepRecentTokens: 1 }, retry: { baseDelayMs: 0 } };
function answer(patch: Partial<NativeReply> = {}): NativeReply { return { text: "answer", usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20, promptTokensDetails: { cachedTokens: 2, cacheWriteTokens: 3 }, cost: 0.02 }, ...patch }; }
function toolsResponse(ids = ["target"]) { return answer({ toolCalls: ids.map(id => ({ id, name: "lookup", arguments: {} })) }); }
const tool: NonNullable<CreateAgentOptions["tools"]>[number] = {
	name: "lookup", label: "Lookup", description: "Lookup", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	async execute() { return { content: [{ type: "text", text: "target found" }], details: { found: true } }; },
};
const permission = { rules: [{ tool: "lookup", argsPattern: "*", effect: "allow" as const }] };
async function consume(turn: AgentTurn) {
	const events: SessionEvent[] = [];
	for await (const event of turn) events.push(event);
	return { result: await turn.result, events };
}

test("policy waits for the entire persisted batch, returns pending input, and retains the completed configuration snapshot", async () => {
	const saving = gate(), releaseSave = gate(), deciding = gate(), releasePolicy = gate();
	const storage = new MemorySessionStorage(); const effects: string[] = []; const snapshots: ShouldStopAfterTurnContext[] = [];
	const requests: TextOptions[] = []; let callbacks = 0;
	const respond = (context: TextOptions) => { requests.push({ ...context, messages: structuredClone(context.messages) }); return requests.length === 1 ? toolsResponse(["first", "second"]) : answer(); };
	const agent = await createAgent({ ...defaults, permission, tools: [{ ...tool, async execute(_args, context) { effects.push(context.toolCallId!); return tool.execute(_args, context); } }],
		storage: { load: () => storage.load(), async append(entry) {
			if (entry.type === "message" && entry.message.toolCallId === "second") { saving.resolve(); await releaseSave.promise; }
			await storage.append(entry);
		} },
		adapter: replyAdapter(model, respond),
		shouldStopAfterTurn: async context => {
			callbacks++; snapshots.push(context);
			expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.message.content)).toBe(true);
			expect(Reflect.set(context.model, "id", "corrupted")).toBe(false);
			if (callbacks === 1) {
				expect(sessionMessages(await storage.load()).filter(message => message.role === "toolResult")).toHaveLength(2);
				deciding.resolve(); await releasePolicy.promise;
			}
			return true;
		},
	});
	const turn = agent.runTurn("initial"); const running = consume(turn);
	try {
		await saving.promise; expect(callbacks).toBe(0);
		const steering = agent.steer("pending steering", turn.id), followUp = agent.followUp("pending follow-up", turn.id);
		if (!steering.accepted || !followUp.accepted) throw new Error("Expected accepted inputs");
		const receipt = await agent.updateConfiguration({ model: { ...model, id: "next-model" }, adapter: replyAdapter("next-model", respond), systemPrompt: "new instructions" });
		releaseSave.resolve(); await deciding.promise;
		expect(await receipt.applied).toEqual({ status: "applied", revision: receipt.revision });
		expect(snapshots[0]).toMatchObject({ model: { id: model.id }, configurationRevision: 0, turnIndex: 1, usage: { requests: 1, tokens: { totalTokens: 20 }, costUsd: 0.02 } });
		releasePolicy.resolve(); const { result, events } = await running;
		expect(result).toEqual({ status: "success", terminationReason: "policy" });
		expect(events.filter(event => event.type === "agent_end")).toEqual([expect.objectContaining({ outcome: "success", terminationReason: "policy" })]);
		expect(requests).toHaveLength(1); expect(effects.sort()).toEqual(["first", "second"]);
		expect(await steering.processed).toBe(false); expect(await followUp.processed).toBe(false);
		await consume(agent.continue());
		expect(snapshots[1]).toMatchObject({ model: { id: "next-model" }, configurationRevision: receipt.revision, turnIndex: 1, usage: { requests: 1 } });
		expect(JSON.stringify(requests[1])).not.toContain("pending steering"); expect(JSON.stringify(requests[1])).not.toContain("pending follow-up");
		expect(effects).toHaveLength(2);
	} finally { releaseSave.resolve(); releasePolicy.resolve(); await running; await agent.dispose(); }
});

test("round limits count completed tool batches across retries and reset for each invocation", async () => {
	let calls = 0, effects = 0; const snapshots: ShouldStopAfterTurnContext[] = [];
	const agent = await createAgent({ ...defaults, permission, tools: [{ ...tool, async execute(args, context) { effects++; return tool.execute(args, context); } }],
		adapter: replyAdapter(model, () => ++calls === 2 ? answer({ error: { message: "429 rate limit" } }) : toolsResponse([`call-${calls}`])),
		shouldStopAfterTurn: context => { snapshots.push(context); return context.turnIndex >= 2; },
	});
	try {
		expect((await consume(agent.runTurn("first"))).result).toEqual({ status: "success", terminationReason: "policy" });
		expect(calls).toBe(3); expect(effects).toBe(2);
		expect(snapshots.map(context => [context.turnIndex, context.usage.requests, context.usage.tokens?.totalTokens])).toEqual([[1, 1, 20], [2, 3, 60]]);
		expect(snapshots[1]?.usage.costUsd).toBeCloseTo(0.06);
		await consume(agent.runTurn("second"));
		expect(snapshots.slice(2).map(context => [context.turnIndex, context.usage.requests])).toEqual([[1, 1], [2, 2]]);
	} finally { await agent.dispose(); }
});

for (const mode of ["throw", "reject", "invalid"] as const) test(`policy ${mode} settles error without retry, redoing tools, or consuming pending input`, async () => {
	const entered = gate(), release = gate(); const storage = new MemorySessionStorage(); let calls = 0, effects = 0, callbacks = 0;
	const agent = await createAgent({ ...defaults, storage, permission, tools: [{ ...tool, async execute(args, context) { effects++; entered.resolve(); await release.promise; return tool.execute(args, context); } }],
		adapter: replyAdapter(model, () => { calls++; return calls === 1 ? toolsResponse() : answer(); }),
		// @ts-expect-error Deliberately return a non-boolean to verify JavaScript callers fail safely.
		shouldStopAfterTurn: () => {
			if (++callbacks > 1) return false;
			if (mode === "reject") return Promise.reject(new Error("429 rate limit"));
			if (mode === "invalid") return Reflect.get({ invalid: "continue" }, "invalid");
			throw new Error("429 rate limit");
		},
	});
	const turn = agent.runTurn("first"); const running = consume(turn);
	try {
		await entered.promise; const pending = agent.followUp("do not consume", turn.id);
		if (!pending.accepted) throw new Error("Expected accepted input");
		release.resolve(); const { result, events } = await running;
		expect(result).toEqual({ status: "error" }); expect(events.at(-1)).toMatchObject({ type: "agent_end", outcome: "error" });
		expect(events.some(event => event.type === "retry" || event.type === "recovery" || event.type === "compaction")).toBe(false);
		expect([calls, effects, callbacks]).toEqual([1, 1, 1]); expect(await pending.processed).toBe(false);
		const saved = sessionMessages(await storage.load());
		expect(saved.filter(message => message.role === "toolResult")).toHaveLength(1);
		expect(saved.at(-1)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("shouldStopAfterTurn failed") });
		expect((await consume(agent.runTurn("fresh"))).result).toEqual({ status: "success" }); expect(effects).toBe(1);
	} finally { release.resolve(); await running; await agent.dispose(); }
});

for (const late of ["stop", "reject"] as const) test(`cancel does not wait for an uncooperative policy; late ${late} cannot affect reuse`, async () => {
	const entered = gate(), release = gate(); let calls = 0, callbacks = 0; let policySignal: AbortSignal | undefined;
	const agent = await createAgent({ ...defaults, adapter: replyAdapter(model, () => { calls++; return answer(); }), shouldStopAfterTurn: async (_context, signal) => {
		if (++callbacks > 1) return false;
		policySignal = signal; entered.resolve(); await release.promise;
		if (late === "reject") throw new Error("late failure");
		return true;
	} });
	const turn = agent.runTurn("cancel"); const running = consume(turn);
	try {
		await entered.promise; agent.abort();
		expect((await running).result).toEqual({ status: "aborted" }); expect(policySignal?.aborted).toBe(true); expect(calls).toBe(1);
		expect((await consume(agent.runTurn("fresh"))).result).toEqual({ status: "success" });
		release.resolve(); await Promise.resolve(); await Promise.resolve();
		expect((await consume(agent.runTurn("still fresh"))).result).toEqual({ status: "success" });
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("storage failure prevents the policy and fails final settlement", async () => {
	let callbacks = 0, calls = 0;
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...defaults, adapter: replyAdapter(model, () => { calls++; return toolsResponse(); }), tools: [tool], permission,
		storage: { load: () => storage.load(), async append(entry) { if (entry.type === "message" && entry.message.role === "toolResult") throw new Error("disk full"); await storage.append(entry); } },
		shouldStopAfterTurn: () => { callbacks++; return true; },
	});
	try {
		const turn = agent.runTurn("task"); await expect(consume(turn)).rejects.toThrow("disk full");
		expect(await turn.result).toEqual({ status: "error" }); expect([calls, callbacks]).toEqual([1, 0]);
		expect(() => agent.runTurn("reuse")).toThrow("faulted");
	} finally { await agent.dispose(); }
});

for (const stopReason of ["error", "aborted", "length", "deferred"] as const) test(`${stopReason} responses bypass completed-round policy`, async () => {
	let callbacks = 0;
	const agent = await createAgent({ ...defaults, retry: { enabled: false }, adapter: replyAdapter(model, () => answer(stopReason === "length" ? { finishReason: "length" } : stopReason === "deferred" ? { metadata: { forge: { stopReason: "deferred" } } } : { error: { message: stopReason, code: stopReason } })), shouldStopAfterTurn: () => { callbacks++; return true; } });
	try { expect((await consume(agent.runTurn("task"))).result).toEqual({ status: stopReason }); expect(callbacks).toBe(0); }
	finally { await agent.dispose(); }
});

for (const missing of ["usage", "zero", "cost"] as const) test(`missing ${missing} remains unknown across a later known response`, async () => {
	let calls = 0; const snapshots: ShouldStopAfterTurnContext[] = [];
	const agent = await createAgent({ ...defaults, adapter: replyAdapter(model, () => {
		const response = answer(++calls === 1 ? { error: { message: "429 rate limit" } } : {});
		if (calls === 1) {
			if (missing === "usage") Reflect.deleteProperty(response, "usage");
			else if (missing === "cost") Reflect.deleteProperty(response.usage!, "cost");
			else response.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		}
		return response;
	}), shouldStopAfterTurn: context => { snapshots.push(context); return true; } });
	try {
		expect((await consume(agent.runTurn("task"))).result).toEqual({ status: "success", terminationReason: "policy" });
		expect(snapshots[0]?.usage).toMatchObject({ requests: 2, costUsd: null, missingUsageRequests: missing === "cost" ? 0 : 1, missingCostRequests: 1 });
		expect(snapshots[0]?.usage.tokens).toEqual(missing === "cost" ? { input: 20, output: 10, cacheRead: 4, cacheWrite: 6, totalTokens: 40 } : null);
	} finally { await agent.dispose(); }
});

function history() {
	return new MemorySessionStorage([
		{ role: "user", content: [{ type: "text", text: "old task" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "old answer ".repeat(1000) }], timestamp: 2, stopReason: "stop" },
		{ role: "user", content: [{ type: "text", text: "recent task" }], timestamp: 3 },
	]);
}

test.each([false, true])("automatic summary retries count toward policy cost; missing summary usage=%s", async missing => {
	const calls: string[] = []; const snapshots: ShouldStopAfterTurnContext[] = [];
	const agent = await createAgent({ ...defaults, storage: history(), context: { enabled: true, reserveTokens: 98_000, keepRecentTokens: 1 }, maxTokens: 100,
		adapter: replyAdapter(model, (context) => {
			const summary = systemText(context) === SUMMARY_SYSTEM; calls.push(summary ? "summary" : "task");
			const response = answer(summary ? calls.length === 1 ? { error: { message: "429 rate limit" } } : { text: JSON.stringify({ states: [], claims: [], taskChanged: false }) } : {});
			if (missing && calls.length === 1) Reflect.deleteProperty(response, "usage");
			return response;
		}), shouldStopAfterTurn: context => { snapshots.push(context); return context.usage.costUsd === null || context.usage.costUsd >= 0.05; },
	});
	try {
		expect((await consume(agent.runTurn("new task"))).result).toEqual({ status: "success", terminationReason: "policy" });
		expect(calls).toEqual(["summary", "summary", "task"]); expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ turnIndex: 1, usage: { requests: 3, tokens: missing ? null : { totalTokens: 60 }, costUsd: missing ? null : 0.06, missingUsageRequests: missing ? 1 : 0 } });
	} finally { await agent.dispose(); }
});

test.each([false, true])("policy stop=%s blocks the otherwise required post-response summary", async stop => {
	const calls: string[] = []; const storage = history();
	const agent = await createAgent({ ...defaults, storage, context: { enabled: true, keepRecentTokens: 1 },
		adapter: replyAdapter(model, (context) => {
			const summary = systemText(context) === SUMMARY_SYSTEM; calls.push(summary ? "summary" : "task");
			return answer(summary ? { text: JSON.stringify({ states: [], claims: [], taskChanged: false }) } : { usage: { ...answer().usage!, promptTokens: 110_005, totalTokens: 110_010 } });
		}), shouldStopAfterTurn: () => stop,
	});
	try {
		const { result } = await consume(agent.runTurn("task"));
		expect(result).toEqual(stop ? { status: "success", terminationReason: "policy" } : { status: "success" });
		expect(calls).toEqual(stop ? ["task"] : ["task", "summary"]);
		expect((await storage.load()).entries.some(entry => entry.type === "compaction")).toBe(!stop);
	} finally { await agent.dispose(); }
});

test("manual summaries and persisted history are excluded from the next invocation's totals", async () => {
	const snapshots: ShouldStopAfterTurnContext[] = []; let calls = 0;
	const agent = await createAgent({ ...defaults, storage: history(), adapter: replyAdapter(model, (context) => {
		calls++; return answer(systemText(context) === SUMMARY_SYSTEM ? { text: JSON.stringify({ states: [], claims: [], taskChanged: false }) } : {});
	}), shouldStopAfterTurn: context => { snapshots.push(context); return true; } });
	try {
		expect((await agent.compact()).status).toBe("complete");
		await consume(agent.runTurn("task")); expect(calls).toBe(2);
		expect(snapshots[0]).toMatchObject({ turnIndex: 1, usage: { requests: 1, tokens: { totalTokens: 20 }, costUsd: 0.02 } });
	} finally { await agent.dispose(); }
});

test("processed steering stays processed when policy stops before a pending follow-up", async () => {
	const entered = gate(), release = gate(); const contexts: TextOptions[] = []; let rounds = 0;
	const agent = await createAgent({ ...defaults, adapter: replyAdapter(model, async (context) => {
		contexts.push(context);
		if (contexts.length === 1) { entered.resolve(); await release.promise; }
		return answer();
	}), shouldStopAfterTurn: context => { rounds = context.turnIndex; return rounds === 2; } });
	const turn = agent.runTurn("initial"); const running = consume(turn);
	try {
		await entered.promise;
		const processed = agent.steer("processed steering", turn.id), pending = agent.followUp("pending follow-up", turn.id);
		if (!processed.accepted || !pending.accepted) throw new Error("Expected accepted input");
		release.resolve(); expect((await running).result).toEqual({ status: "success", terminationReason: "policy" });
		expect(await processed.processed).toBe(true); expect(await pending.processed).toBe(false);
		expect(rounds).toBe(2); expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1])).toContain("processed steering"); expect(JSON.stringify(contexts[1])).not.toContain("pending follow-up");
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("explicit zero cost with positive usage stays known, and the creation-only policy cannot be patched", async () => {
	let snapshot: ShouldStopAfterTurnContext | undefined;
	const agent = await createAgent({ ...defaults, adapter: replyAdapter(model, () => { const response = answer(); response.usage!.cost = 0; return response; }), shouldStopAfterTurn: context => { snapshot = context; return true; } });
	try {
		// @ts-expect-error Policies are configured only at creation, including for JavaScript callers.
		await expect(agent.updateConfiguration({ shouldStopAfterTurn: () => false })).rejects.toThrow("configured at creation");
		expect((await consume(agent.runTurn("task"))).result).toEqual({ status: "success", terminationReason: "policy" });
		expect(snapshot?.usage).toMatchObject({ requests: 1, costUsd: 0, missingCostRequests: 0, tokens: { totalTokens: 20 } });
	} finally { await agent.dispose(); }
});
