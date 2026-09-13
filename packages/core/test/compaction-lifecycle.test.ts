import { expect, test } from "bun:test";
import { createAgent } from "../src/agent.ts";
import { createScriptedSession } from "./helpers/scripted-session.ts";
import { MemorySessionStorage } from "../src/session-storage.ts";
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

test("successful answer reporting overflow is kept and never regenerated", async () => {
	let calls = 0, summaries = 0;
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, isOverflow: () => true, async summarize() { summaries++; return message("assistant", "checkpoint"); }, async stream() { calls++; return message("assistant", "completed answer"); }, async execute() { throw new Error("no tool"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage: new MemorySessionStorage([message("user", "goal"), message("assistant", "work")]) }, () => core);
	try { for await (const _event of agent.runTurn("continue")) {} expect(calls).toBe(1); expect(summaries).toBeGreaterThan(0); }
	finally { await agent.dispose(); }
});
test("abort immediately after requesting manual compaction never starts a summary", async () => {
	let calls = 0;
	const storage = new MemorySessionStorage([message("user", "old"), message("assistant", "work"), message("user", "recent")]);
	const core = createScriptedSession({ contextWindow: 100000, abortInteractions() {}, async stream() { return message("assistant", "done"); }, async summarize() { calls++; return message("assistant", "checkpoint"); }, async execute() { throw new Error("no tool"); } }, [], { keepRecentTokens: 1 });
	const agent = await createAgent({ ...options, storage }, () => core);
	try { const compacting = agent.compact(); agent.abort(); await compacting; expect(calls).toBe(0); }
	finally { await agent.dispose(); }
});
