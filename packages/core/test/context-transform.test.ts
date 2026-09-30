import type { TextOptions } from "@tanstack/ai";
import { replyAdapter, systemText, type NativeReply } from "../../../tests/fixtures/native-reply.ts";
import { expect, test } from "bun:test";
import { createAgent, LongTermMemory, MemorySessionStorage, type AgentTurn, type CreateAgentOptions, type Model, type TransformContext, type TransformContextContext } from "../src/sdk.ts";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { withScenario } from "../../../tests/support/scenario.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUMMARY_SYSTEM } from "../src/context/compaction.ts";
import { estimateContextTokens } from "../src/usage.ts";

const model: Model<string> = { id: "context-test", name: "Context test", api: "faux", provider: "host", baseUrl: "https://unused.invalid", reasoning: false, input: ["text", "image"], contextWindow: 24000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (text: string): SessionMessage => ({ role: "user", timestamp: 1, content: [{ type: "text", text }] });
function answer(patch: Partial<NativeReply> = {}): NativeReply { return { text: "answer", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 }, ...patch }; }
async function consume(turn: AgentTurn) { const events: SessionEvent[] = []; for await (const event of turn) events.push(event); return { events, result: await turn.result }; }
const defaults = { model, maxTokens: 1024, context: { enabled: false, reserveTokens: 8000 }, retry: { baseDelayMs: 0 } };
const lookup: NonNullable<CreateAgentOptions["tools"]>[number] = { name: "lookup", label: "Lookup", description: "Lookup", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { return { content: [{ type: "text", text: "actual tool result" }], details: { original: true } }; } };
const permission = { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] };

for (const delta of [-1, 0, 1]) test(`final hard boundary delta=${delta} differs from the soft threshold`, () => withScenario(`hard-${delta}`, async s => {
	let calls = 0, transformed = 0;
	const agent = await s.agent({ ...defaults, transformContext: context => {
		transformed++; expect(context.budget.inputBudget).toBe(16000); expect(context.budget.maxInputTokens).toBe(21952);
		return [user("x".repeat((21952 + delta - context.budget.fixedTokens - 1) * 4))];
	}, adapter: replyAdapter(model, (context) => { calls++; expect(context.modelOptions?.max_output_tokens).toBe(1024); return answer(); }) });
	const { result, events } = await consume(agent.runTurn("task"));
	expect(result.status).toBe(delta > 0 ? "error" : "success"); expect(calls).toBe(delta > 0 ? 0 : 1); expect(transformed).toBe(1);
	expect(events.some(e => e.type === "retry" || e.type === "recovery")).toBe(false);
	if (delta > 0) expect(JSON.stringify(events)).toContain("request-budget (general)");
}));

for (const kind of ["input", "system", "tools", "image"] as const) test(`no callback and disabled compaction still checks ${kind}`, () => withScenario(`no-hook-${kind}`, async s => {
	let calls = 0;
	const agent = await s.agent({ ...defaults, ...(kind === "system" ? { systemPrompt: "s".repeat(100000) } : {}),
		...(kind === "tools" ? { tools: [{ ...lookup, description: "schema".repeat(20000) }] } : {}),
		...(kind === "image" ? { storage: new MemorySessionStorage([{ ...user("image"), content: Array.from({ length: 24 }, () => ({ type: "image" as const, data: "eA==", mimeType: "image/png" })) }]) } : {}),
		adapter: replyAdapter(model, () => { calls++; return answer(); }),
	});
	expect((await consume(agent.runTurn(kind === "input" ? "x".repeat(100000) : "task"))).result.status).toBe("error"); expect(calls).toBe(0);
}));

test("projection is isolated, selected history stays durable, usage is invalidated and signatures survive", () => withScenario("isolation", async s => {
	const stored: SessionMessage = { role: "assistant", timestamp: 2, provider: model.provider, model: model.id, api: model.api, stopReason: "stop", content: [{ type: "thinking", thinking: "thought", thinkingSignature: "opaque-signature" }, { type: "text", text: "old answer", textSignature: "opaque-text" }], usage: { input: 100000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 100005, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const storage = new MemorySessionStorage([user("keep original"), stored]);
	let returned: SessionMessage[] = []; let callbacks = 0;
	const entered = s.gate("stream"), release = s.gate("release"); const requests: TextOptions[] = [];
	const agent = await s.agent({ ...defaults, model: { ...model, headers: { Authorization: "PRIVATE_HEADER" } }, storage,
		transformContext: context => {
			callbacks++; expect(Object.isFrozen(context.messages[0]?.content)).toBe(true); expect(context.model.headers).toBeUndefined();
			expect(Reflect.set(context.messages[0]!, "timestamp", 55)).toBe(false);
			returned = [stored, user(`temporary reference ${callbacks}`), user("short current task")]; return returned;
		}, adapter: replyAdapter(model, async (context) => { requests.push(context); entered.release(); await release.wait(); return answer(); }),
	});
	const running = consume(agent.runTurn("real current task")); await entered.wait();
	expect(agent.getUsage()).toMatchObject({ contextEstimated: true }); expect(agent.getUsage()?.contextTokens).toBeLessThan(1000);
	returned[1]!.content = [{ type: "text", text: "late corruption" }];
	expect(JSON.stringify(requests[0])).toContain("temporary reference 1"); expect(JSON.stringify(requests[0])).not.toContain("late corruption");
	const assistant = requests[0]?.messages.find(m => m.role === "assistant");
	expect(assistant?.thinking).toContainEqual(expect.objectContaining({ signature: "opaque-signature" }));
	expect(JSON.stringify(assistant)).toContain("opaque-text"); expect(JSON.stringify(assistant)).not.toContain("100005");
	release.release(); expect((await running).result.status).toBe("success");
	const saved = JSON.stringify(await storage.load()); expect(saved).toContain("keep original"); expect(saved).toContain("real current task"); expect(saved).toContain("100005"); expect(saved).not.toContain("temporary reference");
	const reopened = await s.agent({ ...defaults, storage, adapter: replyAdapter(model, (context) => { expect(JSON.stringify(context)).not.toContain("temporary reference"); return answer(); }) });
	expect((await consume(reopened.runTurn("reopen"))).result.status).toBe("success");
}));

for (const mode of ["throw", "reject", "empty", "role", "orphan", "missing", "duplicate", "terminal", "arguments"] as const) test(`host ${mode} failure never enters retry or recovery and can be reused`, () => withScenario(`invalid-${mode}`, async s => {
	let count = 0, calls = 0;
	const callback = (context: TransformContextContext): unknown => {
		if (++count > 1) return context.messages;
		if (mode === "throw") throw new Error("429 rate limit / prompt is too long: 50000 tokens > 24000 maximum");
		if (mode === "reject") return Promise.reject(new Error("503 overloaded"));
		if (mode === "empty") return [];
		if (mode === "role") return [{ ...user("bad"), role: "system" }];
		const call: SessionMessage = { role: "assistant", timestamp: 1, stopReason: "tool_use", content: [{ type: "tool_call", id: "a", name: "lookup", arguments: mode === "arguments" ? { invalid: Infinity } : {} }] };
		const result: SessionMessage = { role: "toolResult", timestamp: 2, toolCallId: "a", toolName: "lookup", content: [{ type: "text", text: "result" }] };
		if (mode === "orphan") return [result];
		if (mode === "missing") return [call, user("missing")];
		if (mode === "duplicate") return [call, result, result];
		if (mode === "terminal") return [{ ...call, content: [{ type: "text", text: "terminal assistant" }], stopReason: "stop" }];
		return [call, result];
	};
	// Deliberately exercise JavaScript-invalid callback output through the SDK boundary.
	const agent = await s.agent({ ...defaults, context: { enabled: true }, transformContext: callback as TransformContext, adapter: replyAdapter(model, () => { calls++; return answer(); }) });
	const first = await consume(agent.runTurn("invalid")); expect(first.result.status).toBe("error"); expect(calls).toBe(0);
	expect(first.events.some(e => e.type === "retry" || e.type === "recovery" || e.type === "compaction")).toBe(false);
	expect((await consume(agent.runTurn("valid"))).result.status).toBe("success"); expect(calls).toBe(1);
}));

for (const late of ["resolve", "reject"] as const) test(`abort releases uncooperative callback and isolates late ${late}`, () => withScenario(`cancel-${late}`, async s => {
	const entered = s.gate("callback"), release = s.gate("late"); let callbacks = 0, calls = 0; let signal: AbortSignal | undefined;
	const agent = await s.agent({ ...defaults, transformContext: async (context, currentSignal) => {
		if (++callbacks > 1) return context.messages;
		signal = currentSignal; entered.release(); await release.wait();
		if (late === "reject") throw new Error("late host failure");
		return [user("late host messages")];
	}, adapter: replyAdapter(model, () => { calls++; return answer(); }) });
	const turn = agent.runTurn("cancel"); const running = consume(turn); await entered.wait();
	const pending = agent.followUp("not consumed", turn.id); if (!pending.accepted) throw new Error("Expected input acceptance");
	agent.abort(); expect((await running).result.status).toBe("aborted"); expect(signal?.aborted).toBe(true); expect(calls).toBe(0); expect(await pending.processed).toBe(false);
	expect((await consume(agent.runTurn("fresh"))).result.status).toBe("success"); release.release(); await Promise.resolve(); await Promise.resolve();
	expect((await consume(agent.runTurn("fresh again"))).result.status).toBe("success"); expect(calls).toBe(2);
}));

test("dispose cancels callback, pending configuration, and the invocation", () => withScenario("dispose", async s => {
	const entered = s.gate("callback"), release = s.gate("host"); let calls = 0;
	const agent = await s.agent({ ...defaults, transformContext: async context => { entered.release(); await release.wait(); return context.messages; }, adapter: replyAdapter(model, () => { calls++; return answer(); }) });
	const turn = agent.runTurn("dispose"); const running = consume(turn); await entered.wait();
	const receipt = await agent.updateConfiguration({ systemPrompt: "pending" });
	await agent.dispose(); expect((await running).result.status).toBe("aborted"); expect(calls).toBe(0); expect((await receipt.applied).status).toBe("canceled");
}));

test("configuration accepted during callback applies only to next request", () => withScenario("configuration", async s => {
	const entered = s.gate("callback"), release = s.gate("release"); const snapshots: TransformContextContext[] = []; const requests: Array<{ id: string; system: string | undefined; output: number | undefined; tools: string[] }> = [];
	const respond = (context: TextOptions) => { requests.push({ id: context.model, system: systemText(context), output: context.modelOptions?.max_output_tokens, tools: context.tools?.map(t => t.name) ?? [] }); return answer(); };
	const agent = await s.agent({ ...defaults, transformContext: async context => { snapshots.push(context); if (snapshots.length === 1) { entered.release(); await release.wait(); } return context.messages; },
		adapter: replyAdapter(model, respond),
	});
	const running = consume(agent.runTurn("first")); await entered.wait();
	const receipt = await agent.updateConfiguration({ model: { ...model, id: "new-model" }, adapter: replyAdapter("new-model", respond), systemPrompt: "NEW SYSTEM", maxTokens: 2048, tools: [lookup] });
	let applied = false; void receipt.applied.then(() => { applied = true; }); await Promise.resolve(); expect(applied).toBe(false);
	release.release(); expect((await running).result.status).toBe("success"); expect((await receipt.applied).status).toBe("applied");
	await consume(agent.runTurn("second")); expect(requests[0]).toMatchObject({ id: model.id, output: 1024 }); expect(requests[0]?.system).not.toBe("NEW SYSTEM");
	expect(requests[1]).toMatchObject({ id: "new-model", system: "NEW SYSTEM", output: 2048, tools: expect.arrayContaining(["lookup"]) });
	expect(snapshots.map(c => c.configurationRevision)).toEqual([0, receipt.revision]); expect(snapshots.map(c => c.budget.maxTokens)).toEqual([1024, 2048]);
	// @ts-expect-error Creation-only callback is also rejected at runtime.
	await expect(agent.updateConfiguration({ transformContext: (c: TransformContextContext) => c.messages })).rejects.toThrow("configured at creation");
	await expect(agent.updateConfiguration({ maxTokens: 4097 })).rejects.toThrow("model.maxTokens");
	await consume(agent.runTurn("configuration survived")); expect(requests.at(-1)?.output).toBe(2048);
}));

test("invalid callback and impossible configured output fail at creation", async () => {
	const options = { ...defaults, cwd: process.cwd(), systemPrompt: "", adapter: replyAdapter(model, () => answer()) };
	// @ts-expect-error Verify JavaScript creation validation.
	await expect(createAgent({ ...options, transformContext: true })).rejects.toThrow("must be a function");
	await expect(createAgent({ ...options, maxTokens: 4097 })).rejects.toThrow("model.maxTokens");
});

test("tool continuation, steering, follow-up and retries each prepare fresh context", () => withScenario("coverage", async s => {
	const first = s.gate("request"), release = s.gate("release"); let calls = 0, callbacks = 0, effects = 0;
	const agent = await s.agent({ ...defaults, tools: [{ ...lookup, async execute(args, context) { effects++; return lookup.execute(args, context); } }], permission,
		transformContext: context => { callbacks++; return [user(`reference-${callbacks}`), ...context.messages]; },
		adapter: replyAdapter(model, async (context) => {
			calls++; expect(JSON.stringify(context)).toContain(`reference-${calls}`); if (calls > 1) expect(JSON.stringify(context)).not.toContain(`reference-${calls - 1}`);
			if (calls === 1) { first.release(); await release.wait(); return answer({ toolCalls: [{ id: "tool", name: "lookup", arguments: {} }] }); }
			if (calls === 2 || calls === 5) return answer({ error: { message: "429 rate limit" } });
			return answer();
		}),
	});
	const turn = agent.runTurn("initial"), running = consume(turn); await first.wait();
	const steering = agent.steer("steering", turn.id), followup = agent.followUp("followup", turn.id); if (!steering.accepted || !followup.accepted) throw new Error("Expected acceptance");
	release.release(); expect((await running).result.status).toBe("success"); expect(await steering.processed).toBe(true); expect(await followup.processed).toBe(true); expect(effects).toBe(1); expect(callbacks).toBe(calls);
	// A failed standalone request leaves a resumable user context; continue invokes the same callback.
	await agent.updateConfiguration({ systemPrompt: "changed" });
	const fresh = await consume(agent.runTurn("next")); expect(fresh.result.status).toBe("success"); expect(callbacks).toBe(calls);
}));

test("failed callback after consumed steering returns only unconsumed follow-up", () => withScenario("processed", async s => {
	const entered = s.gate("request"), release = s.gate("release"); let callbacks = 0, calls = 0;
	const agent = await s.agent({ ...defaults, transformContext: context => { if (++callbacks === 2) throw new Error("host failed"); return context.messages; }, adapter: replyAdapter(model, async () => { calls++; entered.release(); await release.wait(); return answer(); }) });
	const turn = agent.runTurn("initial"), running = consume(turn); await entered.wait();
	const steering = agent.steer("consumed", turn.id), followup = agent.followUp("pending", turn.id); if (!steering.accepted || !followup.accepted) throw new Error("Expected acceptance");
	release.release(); expect((await running).result.status).toBe("error"); expect(await steering.processed).toBe(true); expect(await followup.processed).toBe(false); expect(calls).toBe(1);
	expect((await consume(agent.runTurn("reuse after preparation error"))).result.status).toBe("success"); expect(callbacks).toBe(3);
}));

test("compaction precedes host while native memory recall reaches the final request", () => withScenario("memory-order", async s => {
	await writeFile(join(s.cwd, "MEMORY.md"), "MEMORY_REFERENCE");
	const memory = new LongTermMemory({ project: s.cwd }); const order: string[] = []; let callbacks = 0;
	const storage = new MemorySessionStorage([user("old"), { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "old history ".repeat(2000) }] }, user("recent")]);
	const agent = await s.agent({ ...defaults, storage, context: { enabled: true, reserveTokens: 20000, keepRecentTokens: 1 }, memory: { store: memory, autoUpdate: false },
		transformContext: context => { order.push("host"); callbacks++; expect(JSON.stringify(context.messages)).not.toContain("MEMORY_REFERENCE"); return callbacks === 1 ? [user("x".repeat((context.budget.inputBudget + 100 - context.budget.fixedTokens) * 4))] : context.messages; },
		adapter: replyAdapter(model, (context) => {
			if (systemText(context) === SUMMARY_SYSTEM) { order.push("summary"); return answer({ text: JSON.stringify({ states: [], claims: [], taskChanged: false }) }); }
			order.push("task"); expect(JSON.stringify(context)).toContain("MEMORY_REFERENCE");
			return answer();
		}),
	});
	const first = await consume(agent.runTurn("new")); expect(first.result.status).toBe("success"); expect(order.slice(0, 3)).toEqual(["summary", "host", "task"]);
	expect(first.events).toContainEqual(expect.objectContaining({ type: "memory", phase: "recall" }));
	expect((await consume(agent.runTurn("short new task"))).result.status).toBe("success"); expect(callbacks).toBe(2);
	const before = callbacks; await agent.compact(); expect(callbacks).toBe(before);
}));

test("mixed content counted after conversion, details omitted, and stop policy blocks future preparation", () => withScenario("counting-policy", async s => {
	let callbacks = 0, calls = 0, fixedTokens = 0; let returned: SessionMessage[] = [];
	const agent = await s.agent({ ...defaults, tools: [lookup], permission, transformContext: context => {
		callbacks++; fixedTokens = context.budget.fixedTokens; returned = [{ role: "assistant", timestamp: 1, stopReason: "tool_use", content: [{ type: "thinking", thinking: "思考".repeat(100), thinkingSignature: "opaque" }, { type: "tool_call", id: "past", name: "lookup", arguments: { query: "q".repeat(100) } }] },
		{ role: "toolResult", timestamp: 2, toolCallId: "past", toolName: "lookup", details: { invisible: "x".repeat(200000) }, content: [{ type: "image", data: "eA==", mimeType: "image/png" }, { type: "text", text: "result" }] }]; return [...returned, ...context.messages];
	}, adapter: replyAdapter(model, (context) => { calls++; const expected = estimateContextTokens([...returned, user("task")]) + fixedTokens; expect(agent.getUsage()?.contextTokens).toBe(expected); expect(JSON.stringify(context.messages)).not.toContain("invisible"); return answer({ toolCalls: [{ id: "next", name: "lookup", arguments: {} }] }); }), shouldStopAfterTurn: context => { expect(context.usage.requests).toBe(1); return true; } });
	expect((await consume(agent.runTurn("task"))).result).toEqual({ status: "success", terminationReason: "policy" }); expect([calls, callbacks]).toEqual([1, 1]);
}));

test("continue from stored user context prepares a request", () => withScenario("continue", async s => {
	let callbacks = 0;
	const agent = await s.agent({ ...defaults, storage: new MemorySessionStorage([user("unfinished")]), transformContext: context => { callbacks++; return context.messages; }, adapter: replyAdapter(model, () => answer()) });
	expect((await consume(agent.continue())).result.status).toBe("success"); expect(callbacks).toBe(1);
}));

test("preparation failure applies queued configuration but never sends the failed request", () => withScenario("failed-config", async s => {
	const entered = s.gate("host"), release = s.gate("release"); let callbacks = 0, calls = 0;
	const agent = await s.agent({ ...defaults, transformContext: async context => { if (++callbacks === 1) { entered.release(); await release.wait(); throw new Error("503 host unavailable"); } expect(context.configurationRevision).toBe(1); return context.messages; }, adapter: replyAdapter(model, (context) => { calls++; expect(systemText(context)).toBe("NEW"); return answer(); }) });
	const running = consume(agent.runTurn("fail")); await entered.wait(); const receipt = await agent.updateConfiguration({ systemPrompt: "NEW" }); release.release();
	expect((await running).result.status).toBe("error"); expect(calls).toBe(0); expect((await receipt.applied).status).toBe("applied");
	expect((await consume(agent.runTurn("fresh"))).result.status).toBe("success"); expect(calls).toBe(1);
}));

test("storage failure prevents context callback and faults the instance", () => withScenario("storage-failure", async s => {
	let callbacks = 0, calls = 0;
	const agent = await s.agent({ ...defaults, storage: { load: () => s.storage.load(), async append() { throw new Error("disk failed"); } }, transformContext: context => { callbacks++; return context.messages; }, adapter: replyAdapter(model, () => { calls++; return answer(); }) });
	const turn = agent.runTurn("fail"); await expect(consume(turn)).rejects.toThrow("disk failed"); expect((await turn.result).status).toBe("error"); expect([callbacks, calls]).toEqual([0, 0]); expect(() => agent.runTurn("reuse")).toThrow("faulted");
}));

test("iterator close during callback cancels preparation without waiting for the host", () => withScenario("iterator-close", async s => {
	const entered = s.gate("host"), release = s.gate("release"); let calls = 0;
	const agent = await s.agent({ ...defaults, transformContext: async context => { entered.release(); await release.wait(); return context.messages; }, adapter: replyAdapter(model, () => { calls++; return answer(); }) });
	const turn = agent.runTurn("close"), iterator = turn[Symbol.asyncIterator](); await iterator.next(); await entered.wait(); await iterator.return?.(); expect((await turn.result).status).toBe("aborted"); expect(calls).toBe(0);
}));

test("normal overflow recovery prepares a new host projection without replaying tools", () => withScenario("overflow", async s => {
	let callbacks = 0, tasks = 0, summaries = 0;
	const storage = new MemorySessionStorage([user("old"), { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "old ".repeat(1000) }] }]);
	const agent = await s.agent({ ...defaults, storage, context: { enabled: true, keepRecentTokens: 1 }, transformContext: context => { callbacks++; return context.messages; }, adapter: replyAdapter(model, (context) => {
		if (systemText(context) === SUMMARY_SYSTEM) { summaries++; return answer({ text: JSON.stringify({ states: [], claims: [], taskChanged: false }) }); }
		return ++tasks === 1 ? answer({ error: { message: "prompt is too long: 25000 tokens > 24000 maximum" } }) : answer();
	}) });
	const { result, events } = await consume(agent.runTurn("current")); expect(result.status).toBe("success"); expect([tasks, callbacks, summaries]).toEqual([2, 2, 1]); expect(events.filter(e => e.type === "recovery")).toHaveLength(1);
}));

test("Skills expansion and configuration are included before host preparation", () => withScenario("skills-transform", async s => {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(s.cwd, "guide")); await writeFile(join(s.cwd, "guide", "SKILL.md"), "---\nname: guide\ndescription: Workflow guide\n---\nSKILL_BODY");
	const entered = s.gate("callback"), release = s.gate("release"); const snapshots: TransformContextContext[] = []; const systems: string[] = [];
	const agent = await s.agent({ ...defaults, permission, skills: { roots: { workspace: { path: s.cwd } } }, transformContext: async context => { snapshots.push(context); if (snapshots.length === 1) { entered.release(); await release.wait(); } return context.messages; }, adapter: replyAdapter(model, (context) => { systems.push(systemText(context) ?? ""); return answer(); }) });
	const running = consume(agent.runTurn({ kind: "skill", name: "guide", task: "use skill" })); await entered.wait(); expect(JSON.stringify(snapshots[0]?.messages)).toContain("SKILL_BODY");
	const receipt = await agent.updateConfiguration({ skills: false }); release.release(); expect((await running).result.status).toBe("success"); await receipt.applied;
	await consume(agent.runTurn("next")); expect(systems[0]).toContain("Workflow guide"); expect(systems[1]).not.toContain("Workflow guide"); expect(snapshots.map(c => c.configurationRevision)).toEqual([0, 1]); expect(snapshots[0]!.budget.fixedTokens).toBeGreaterThan(snapshots[1]!.budget.fixedTokens);
}));
