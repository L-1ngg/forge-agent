import { expect, test } from "bun:test";
import { createAgent } from "../src/agent.ts";
import { createScriptedSession, type ScriptedDriver } from "./helpers/scripted-session.ts";
import { MemorySessionStorage, type SessionEntry } from "../src/session-storage.ts";
import type { SessionMessage } from "@forge-agent/protocol";

const options = { provider: "faux", model: "faux-1", systemPrompt: "task-system", cwd: process.cwd() };
const message = (role: "user" | "assistant", text: string): SessionMessage => ({ role, content: [{ type: "text", text }], timestamp: 1, ...(role === "assistant" ? { stopReason: "stop" as const } : {}) });

test("normal length output remains available when a later user asks to continue", async () => {
	let calls = 0;
	const requests: string[] = [];
	const core = createScriptedSession({ contextWindow: 100000, maxTokens: 100, abortInteractions() {}, async stream(messages) {
		requests.push(JSON.stringify(messages));
		return ++calls === 1 ? { ...message("assistant", "previous partial answer"), stopReason: "length", content: [...message("assistant", "previous partial answer").content, { type: "tool_call", id: "truncated", name: "write", arguments: {} }] } : message("assistant", "continued");
	}, async execute() { throw new Error("truncated tool must not run"); } }, [], { enabled: false });
	const agent = await createAgent(options, () => core);
	try {
		for await (const _event of agent.runTurn("start")) {}
		for await (const _event of agent.runTurn("continue")) {}
		expect(requests[1]).toContain("previous partial answer");
		expect(requests[1]).not.toContain("truncated");
	} finally { await agent.dispose(); }
});

test("failed recovery compaction stops without resending the task", async () => {
	let calls = 0, summaries = 0;
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, isOverflow: () => true, async stream() { calls++; return { ...message("assistant", "partial"), stopReason: "error", errorMessage: "overflow" }; }, async summarize() { summaries++; throw new Error("summary unavailable"); }, async execute() { throw new Error("no tools"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage: new MemorySessionStorage([message("user", "old"), message("assistant", "work")]) }, () => core);
	try { for await (const _event of agent.runTurn("continue")) {} expect([calls, summaries]).toEqual([1, 1]); }
	finally { await agent.dispose(); }
});

test("a larger summary is published once and unchanged history skips another compaction", async () => {
	let calls = 0;
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, async stream() { return message("assistant", "done"); }, async summarize() { calls++; return message("assistant", "larger summary ".repeat(100)); }, async execute() { throw new Error("no tools"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage: new MemorySessionStorage([message("user", "old"), message("assistant", "work"), message("user", "recent")]) }, () => core);
	try { const result = await agent.compact(); expect(result.status).toBe("complete"); expect(result.afterTokens).toBeGreaterThan(result.beforeTokens); expect((await agent.compact()).status).toBe("skipped"); expect(calls).toBe(1); }
	finally { await agent.dispose(); }
});

test("abort during summary retry backoff prevents another model call", async () => {
	let calls = 0;
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, isRetryable: () => true, async stream() { return message("assistant", "done"); }, async summarize() { calls++; return { ...message("assistant", ""), stopReason: "error", errorMessage: "503" }; }, async execute() { throw new Error("no tools"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage: new MemorySessionStorage([message("user", "old"), message("assistant", "work"), message("user", "recent")]) }, () => core);
	try { expect((await agent.compact(undefined, (event) => { if (event.type === "compaction" && event.phase === "retry") agent.abort(); })).status).toBe("error"); expect(calls).toBe(1); }
	finally { await agent.dispose(); }
});

test.each([{ retry: { maxRetries: -1 } }, { retry: { baseDelayMs: Infinity } }, { maxTokens: 0 }, { contextWindow: NaN }])("SDK rejects invalid request settings before creating a port: %j", async (settings) => {
	let ports = 0;
	await expect(createAgent({ ...options, ...settings }, () => { ports++; throw new Error("must not create port"); })).rejects.toThrow("Invalid");
	expect(ports).toBe(0);
});

for (const window of [105, 106]) test(`automatic threshold is strict at equality (window=${window})`, async () => {
	let summaries = 0;
	const storage = new MemorySessionStorage([message("user", "1234"), message("assistant", "1234")]);
	const core = createScriptedSession({ contextWindow: window, abortInteractions() {}, async stream() { return message("assistant", "done"); }, async summarize() { summaries++; return message("assistant", "checkpoint"); }, async execute() { throw new Error("no tools"); } }, [], { reserveTokens: 100, keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try { for await (const _event of agent.runTurn("1234")) {} expect(summaries).toBe(window === 105 ? 1 : 0); }
	finally { await agent.dispose(); }
});

for (const mode of ["error", "length", "empty", "tool"] as const) test(`invalid ${mode} summary leaves the old view and proactive requests continue`, async () => {
	let calls = 0, summaries = 0;
	const storage = new MemorySessionStorage([message("user", "old ".repeat(100)), message("assistant", "work")]);
	const core = createScriptedSession({
		contextWindow: 100, abortInteractions() {},
		async summarize() { summaries++; return mode === "tool" ? { ...message("assistant", "text"), content: [{ type: "tool_call", id: "bad", name: "read", arguments: {} }] } : { ...message("assistant", mode === "empty" ? "" : "partial"), ...(mode === "error" || mode === "length" ? { stopReason: mode } : {}) }; },
		async stream(messages) { calls++; expect(JSON.stringify(messages)).toContain("old old"); return message("assistant", "done"); },
		async execute() { throw new Error("no tool"); },
	}, [], { reserveTokens: 20, keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try { for await (const _event of agent.runTurn("continue")) {} expect(calls).toBe(1); expect(summaries).toBe(1); expect((await storage.load()).entries.some((entry) => entry.type === "compaction")).toBe(false); }
	finally { await agent.dispose(); }
});

test("auto off disables both threshold and overflow recovery while manual compaction remains available", async () => {
	let summaries = 0, calls = 0;
	const storage = new MemorySessionStorage([message("user", "goal"), message("assistant", "work")]);
	const core = createScriptedSession({ contextWindow: 1, abortInteractions() {}, isOverflow: () => true, async summarize() { summaries++; return message("assistant", "checkpoint"); }, async stream() { calls++; return { ...message("assistant", "failed"), stopReason: "error", errorMessage: "overflow" }; }, async execute() { throw new Error("no tool"); } }, [], { enabled: false, keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try { for await (const _event of agent.runTurn("continue")) {} expect([summaries, calls]).toEqual([0, 1]); expect((await agent.compact()).status).toBe("complete"); expect(summaries).toBeGreaterThan(0); }
	finally { await agent.dispose(); }
});

test("successful answer reporting overflow is kept and never regenerated", async () => {
	let calls = 0, summaries = 0;
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, isOverflow: () => true, async summarize() { summaries++; return message("assistant", "checkpoint"); }, async stream() { calls++; return message("assistant", "completed answer"); }, async execute() { throw new Error("no tool"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage: new MemorySessionStorage([message("user", "goal"), message("assistant", "work")]) }, () => core);
	try { for await (const _event of agent.runTurn("continue")) {} expect(calls).toBe(1); expect(summaries).toBeGreaterThan(0); }
	finally { await agent.dispose(); }
});
test("manual compact interrupts active consumption, waits for cleanup and remains idle", async () => {
	const storage = new MemorySessionStorage([message("user", "previous goal"), message("assistant", "previous work")]);
	let notify!: () => void;
	const started = new Promise<void>((resolve) => { notify = resolve; });
	let cleaned = false, calls = 0;
	const core = createScriptedSession({
		contextWindow: 100000, abortInteractions() {},
		async stream(_messages, signal) { calls++; notify(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true })); return { ...message("assistant", "partial"), stopReason: "aborted" }; },
		async summarize() { expect(cleaned).toBe(true); return message("assistant", "checkpoint"); },
		async execute() { throw new Error("no tool"); },
	}, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	const consuming = (async () => { for await (const _event of agent.runTurn("current")) {} })();
	try {
		await started;
		expect((await agent.compact()).status).toBe("complete");
		await consuming;
		expect(calls).toBe(1);
		expect(cleaned).toBe(true);
	} finally { agent.abort(); await consuming.catch(() => {}); await agent.dispose(); }
});

test("abort immediately after requesting manual compaction never starts a summary", async () => {
	let calls = 0;
	const storage = new MemorySessionStorage([message("user", "old"), message("assistant", "work"), message("user", "recent")]);
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, async stream() { return message("assistant", "done"); }, async summarize() { calls++; return message("assistant", "checkpoint"); }, async execute() { throw new Error("no tool"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try { const compacting = agent.compact(); agent.abort(); await compacting; expect(calls).toBe(0); }
	finally { await agent.dispose(); }
});
test("SDK manually compacts history, keeps recent text, and reloads the same request view", async () => {
	const storage = new MemorySessionStorage([message("user", "old goal"), message("assistant", "old work"), message("user", "recent goal")]);
	const summaries: string[] = [];
	const requests: readonly SessionMessage[][] = [];
	const driver: ScriptedDriver = {
		contextWindow: 100000, maxTokens: 4096, abortInteractions() {},
		async summarize(request) { summaries.push(request.prompt); return message("assistant", "checkpoint: old goal"); },
		async stream(messages) { (requests as SessionMessage[][]).push(structuredClone([...messages])); return message("assistant", "answer"); },
		async execute() { throw new Error("unexpected tool"); },
	};
	const agent = await createAgent({ ...options, storage, context: { keepRecentTokens: 1 } }, () => createScriptedSession(driver, [], { keepRecentTokens: 1 }));
	try {
		const result = await agent.compact("remember constraints");
		expect(result.status).toBe("complete");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toContain("remember constraints");
		expect(requests).toHaveLength(0);
		const saved = await storage.load();
		expect(saved.entries.filter((entry: SessionEntry) => entry.type === "compaction")).toHaveLength(1);
		expect(saved.entries.filter((entry: SessionEntry) => entry.type === "message")).toHaveLength(3);
	} finally { await agent.dispose(); }
	const reopened = await createAgent({ ...options, storage }, () => createScriptedSession(driver));
	try {
		for await (const _event of reopened.runTurn("continue")) {}
		expect(JSON.stringify(requests[0])).toContain("checkpoint: old goal");
		expect(JSON.stringify(requests[0])).toContain("recent goal");
		expect(JSON.stringify(requests[0])).not.toContain("old work");
	} finally { await reopened.dispose(); }
});

test("overflow and length share one recovery after partial output and never execute truncated calls", async () => {
	const storage = new MemorySessionStorage([message("user", "goal"), message("assistant", "prior work")]);
	let calls = 0, summaries = 0, tools = 0;
	const requests: string[] = [];
	const core = createScriptedSession({
		contextWindow: 100000, maxTokens: 100, abortInteractions() {},
		isOverflow: (response) => response.errorMessage === "context overflow",
		async summarize() { summaries++; return message("assistant", "checkpoint"); },
		async stream(messages, _signal, emit) {
			requests.push(JSON.stringify(messages));
			emit({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "partial output" });
			if (++calls === 1) return { ...message("assistant", "failed partial"), stopReason: "error", errorMessage: "context overflow" };
			return { role: "assistant", timestamp: 3, stopReason: "length", usage: { input: 100, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 102 }, content: [{ type: "tool_call", id: "truncated", name: "write", arguments: {} }] };
		},
		async execute() { tools++; throw new Error("must not execute"); },
	}, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try {
		for await (const _event of agent.runTurn("continue")) {}
		expect(calls).toBe(2);
		expect(summaries).toBeGreaterThan(0);
		expect(tools).toBe(0);
		expect(requests[1]).not.toContain("failed partial");
		expect(JSON.stringify(await storage.load())).toContain("failed partial");
	} finally { await agent.dispose(); }
});

test("automatic compaction prepares each model request inside a tool loop", async () => {
	const storage = new MemorySessionStorage([message("user", "old goal ".repeat(200)), message("assistant", "old work")]);
	let summaries = 0, calls = 0, tools = 0;
	const core = createScriptedSession({
		contextWindow: 300, toolNames: ["read"], maxTokens: 100, abortInteractions() {},
		async summarize() { summaries++; return message("assistant", "checkpoint"); },
		async stream() {
			if (++calls === 1) return { ...message("assistant", "analysis ".repeat(200)), stopReason: "tool_use", content: [...message("assistant", "analysis ".repeat(200)).content, { type: "tool_call", id: "call", name: "read", arguments: {} }] };
			return message("assistant", "done");
		},
		async execute() { tools++; return { message: { role: "toolResult", toolCallId: "call", toolName: "read", timestamp: 2, content: [{ type: "text", text: "result" }] } }; },
	}, [], { reserveTokens: 100, keepRecentTokens: 20 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try {
		for await (const _event of agent.runTurn("continue")) {}
		expect(summaries).toBe(2);
		expect(calls).toBe(2);
		expect(tools).toBe(1);
	} finally { await agent.dispose(); }
});

test("summary retries only the failed logical part without a cumulative call cap", async () => {
	const storage = new MemorySessionStorage([message("user", "old"), message("assistant", "old work"), message("user", "current"), message("assistant", "prefix"), message("assistant", "suffix")]);
	let attempts = 0;
	const waits: number[] = [];
	const core = createScriptedSession({
		contextWindow: 100000, abortInteractions() {},
		isRetryable: (response) => response.stopReason === "error" && response.errorMessage === "503",
		async wait(ms) { waits.push(ms); },
		async summarize() { attempts++; return attempts % 4 ? { ...message("assistant", ""), stopReason: "error", errorMessage: "503" } : message("assistant", "checkpoint"); },
		async stream() { return message("assistant", "next"); }, async execute() { throw new Error("no tool"); },
	}, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try {
		expect((await agent.compact()).status).toBe("complete");
		expect(attempts).toBe(8);
		expect(waits).toEqual([2000, 4000, 8000, 2000, 4000, 8000]);
		for (let index = 0; index < 9; index++) {
			for await (const _event of agent.runTurn(`new task ${index}`)) {}
			expect((await agent.compact()).status).toBe("complete");
		}
		expect(attempts).toBeGreaterThan(32);
	} finally { await agent.dispose(); }
});

test("one long invocation keeps working after more than 32 summary attempts", async () => {
	let taskCalls = 0, tools = 0, attempts = 0;
	const core = createScriptedSession({
		contextWindow: 300, toolNames: ["read"], abortInteractions() {}, isRetryable: (response) => response.stopReason === "error", async wait() {},
		async summarize() { return ++attempts % 4 ? { ...message("assistant", ""), stopReason: "error", errorMessage: "503" } : message("assistant", "checkpoint"); },
		async stream() {
			if (++taskCalls > 10) return message("assistant", "all work complete");
			return { ...message("assistant", "work ".repeat(300)), stopReason: "tool_use", content: [...message("assistant", "work ".repeat(300)).content, { type: "tool_call", id: `call-${taskCalls}`, name: "read", arguments: {} }] };
		},
		async execute(call) { tools++; return { message: { role: "toolResult", timestamp: 2, toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "result" }] } }; },
	}, [], { reserveTokens: 100, keepRecentTokens: 20 });
	const agent = await createAgent({ ...options, storage: new MemorySessionStorage([message("user", "old goal ".repeat(200)), message("assistant", "old work")]) }, () => core);
	try {
		const events = [];
		for await (const event of agent.runTurn("finish all work")) events.push(event);
		expect(attempts).toBeGreaterThan(32);
		expect([taskCalls, tools]).toEqual([11, 10]);
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1)).toMatchObject({ message: { content: [{ type: "text", text: "all work complete" }], stopReason: "stop" } });
	} finally { await agent.dispose(); }
});

test("split-turn compaction generates history then prefix and preserves recent original text", async () => {
	const storage = new MemorySessionStorage([message("user", "older task"), message("assistant", "older result"), message("user", "current request"), message("assistant", "prefix work"), message("assistant", "recent suffix")]);
	const prompts: string[] = [];
	const limits: number[] = [];
	const core = createScriptedSession({
		contextWindow: 100000, maxTokens: 50000, abortInteractions() {},
		async summarize(request) { prompts.push(request.prompt); limits.push(request.maxTokens); return message("assistant", prompts.length === 1 ? "history checkpoint" : "turn checkpoint"); },
		async stream() { throw new Error("manual compaction must stay idle"); },
		async execute() { throw new Error("no tool replay"); },
	}, [], { keepRecentTokens: 1, reserveTokens: 100 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try {
		expect((await agent.compact("history focus")).status).toBe("complete");
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("older task");
		expect(prompts[1]).toContain("current request");
		expect(prompts[1]).not.toContain("history focus");
		expect(prompts[1]).not.toContain("recent suffix");
		expect(limits).toEqual([80, 50]);
		const saved = (await storage.load()).entries.at(-1);
		if (saved?.type !== "compaction") throw new Error("missing checkpoint");
		expect(saved.summary).toContain("history checkpoint");
		expect(saved.summary).toContain("turn checkpoint");
		expect((await agent.compact()).status).toBe("skipped");
	} finally { await agent.dispose(); }
});
