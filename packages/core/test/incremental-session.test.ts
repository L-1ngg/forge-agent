import { expect, test } from "bun:test";
import { createAgent } from "../src/agent.ts";
import { createScriptedSession } from "./helpers/scripted-session.ts";
import { MemorySessionStorage, sessionMessages } from "../src/session-storage.ts";
import type { SessionMessage } from "@forge-agent/protocol";

const options = { provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd() };

test("cancellation while launching a batch saves started results but does not start later tools", async () => {
	const storage = new MemorySessionStorage();
	const executed: string[] = [];
	let cancel = () => {};
	const core = createScriptedSession({
		contextWindow: 100000, toolNames: ["first", "second", "write"], abortInteractions() {},
		async stream() { return { role: "assistant", timestamp: 1, stopReason: "tool_use", content: ["first", "second"].map((id) => ({ type: "tool_call" as const, id, name: id, arguments: {} })) }; },
		async execute(call) { executed.push(call.id); cancel(); return { message: { role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: 2, content: [{ type: "text", text: "formed" }] } }; },
	});
	const agent = await createAgent({ ...options, storage }, () => core); cancel = () => agent.abort();
	try {
		for await (const _event of agent.runTurn("work")) {}
		expect(executed).toEqual(["first"]);
		const results = sessionMessages(await storage.load()).filter((message) => message.role === "toolResult");
		expect(results.map(message => message.toolCallId)).toEqual(["first", "second"]);
		expect(results[1]).toMatchObject({ isError: true, content: [{ type: "text", text: "Operation aborted" }] });
	} finally { await agent.dispose(); }
});

test("SDK storage failure before tool dispatch faults the instance without executing tools", async () => {
	const memory = new MemorySessionStorage();
	let executions = 0;
	let writes = 0;
	const core = createScriptedSession({
		contextWindow: 10000, toolNames: ["write"], abortInteractions() {},
		async stream() { return { role: "assistant", timestamp: 2, stopReason: "tool_use", content: [{ type: "tool_call", id: "side-effect", name: "write", arguments: {} }] }; },
		async execute() { executions++; throw new Error("unexpected execution"); },
	});
	const agent = await createAgent({ ...options, storage: {
		load: () => memory.load(),
		async append(entry) { writes++; await memory.append(entry); if (writes === 2) throw new Error("partial write failure"); },
	} }, () => core);
	try {
		await expect((async () => { for await (const _event of agent.runTurn("work")) {} })()).rejects.toThrow("partial write failure");
		expect(executions).toBe(0);
		expect(writes).toBe(2);
		expect((await memory.load()).entries).toHaveLength(2);
		expect(() => agent.runTurn("retry")).toThrow("faulted");
	} finally { await agent.dispose(); }
});

test("SDK reopen filters interrupted responses and projects missing results without replay", async () => {
	const history: SessionMessage[] = [
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "task" }] },
		{ role: "assistant", timestamp: 2, stopReason: "tool_use", content: [{ type: "tool_call", id: "unknown", name: "write", arguments: {} }] },
		{ role: "assistant", timestamp: 3, stopReason: "aborted", content: [{ type: "text", text: "interrupted-secret" }, { type: "tool_call", id: "partial", name: "write", arguments: {} }] },
	];
	const storage = new MemorySessionStorage(history);
	let request: readonly SessionMessage[] = [];
	const core = createScriptedSession({
		contextWindow: 10000, toolNames: ["write"], abortInteractions() {},
		async stream(messages) { request = messages; return { role: "assistant", timestamp: 5, content: [], stopReason: "stop" }; },
		async execute() { throw new Error("must not replay"); },
	});
	const agent = await createAgent({ ...options, storage }, () => core);
	try {
		for await (const _event of agent.runTurn("continue")) {}
		expect(request.filter((message) => message.role === "toolResult")).toMatchObject([{ toolCallId: "unknown", isError: true }]);
		expect(JSON.stringify(request)).toContain("side effects are unknown");
		expect(JSON.stringify(request)).not.toContain("interrupted-secret");
		expect(JSON.stringify(request)).not.toContain("partial");
		expect(sessionMessages(await storage.load()).slice(0, 3)).toEqual(history);
	} finally { await agent.dispose(); }
});

test("SDK saves consumed input before the model and retains it after cancellation", async () => {
	const storage = new MemorySessionStorage();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const core = createScriptedSession({
		contextWindow: 10000, toolNames: ["write"],
		async stream(_messages, signal) {
			started();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", timestamp: 2 };
		},
		async execute() { throw new Error("unexpected tool"); },
		abortInteractions() {},
	});
	const agent = await createAgent({ provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd(), storage }, () => core);
	const running = (async () => { for await (const _event of agent.runTurn("keep this")) {} })();
	try {
		await ready;
		expect((await storage.load()).entries).toHaveLength(1);
		agent.abort();
		await running;
		const saved = await storage.load();
		expect(saved.entries).toHaveLength(2);
		expect(saved.entries[0]).toMatchObject({ type: "message", message: { role: "user", content: [{ type: "text", text: "keep this" }] } });
		expect(saved.entries[1]).toMatchObject({ type: "message", message: { stopReason: "aborted" } });
	} finally { agent.abort(); await running; await agent.dispose(); }
});
