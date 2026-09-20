import { expect, test } from "bun:test";
import { createAgent } from "../src/agent.ts";
import { scriptedModel } from "./helpers/scripted-model.ts";
import { MemorySessionStorage, sessionMessages } from "../src/session-storage.ts";
import type { SessionMessage } from "@forge-agent/protocol";

const options = { provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd() };

test("cancellation while launching a batch saves started results but does not start later tools", async () => {
	const storage = new MemorySessionStorage();
	const executed: string[] = [];
	let cancel = () => {};
	const model = scriptedModel({
		contextWindow: 100000,
		async stream() { return { role: "assistant", timestamp: 1, stopReason: "tool_use", content: ["first", "second"].map((id) => ({ type: "tool_call" as const, id, name: id, arguments: {} })) }; },
	});
	const agent = await createAgent({ ...options, ...model, storage,
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: ["first", "second", "write"].map(name => ({ name, label: name, description: name, parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute(_args, context) { executed.push(context.toolCallId!); cancel(); return { content: [{ type: "text", text: "formed" }], details: undefined }; },
		})),
	}); cancel = () => agent.abort();
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
	const model = scriptedModel({
		contextWindow: 100000,
		async stream() { return { role: "assistant", timestamp: 2, stopReason: "tool_use", content: [{ type: "tool_call", id: "side-effect", name: "write", arguments: {} }] }; },
	});
	const agent = await createAgent({ ...options, ...model,
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "write", label: "Write", description: "write", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { executions++; throw new Error("unexpected execution"); } }], storage: {
		load: () => memory.load(),
		async append(entry) { writes++; await memory.append(entry); if (writes === 2) throw new Error("partial write failure"); },
	} });
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
	const model = scriptedModel({
		contextWindow: 100000,
		async stream(messages) { request = messages; return { role: "assistant", timestamp: 5, content: [], stopReason: "stop" }; },
	});
	let effects = 0;
	const agent = await createAgent({ ...options, ...model, storage,
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "write", label: "Write", description: "write", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { effects++; throw new Error("must not replay"); } }],
	});
	try {
		for await (const _event of agent.runTurn("continue")) {}
		expect(request.filter((message) => message.role === "toolResult")).toMatchObject([{ toolCallId: "unknown", isError: true }]);
		expect(JSON.stringify(request)).toContain("side effects are unknown");
		expect(JSON.stringify(request)).not.toContain("interrupted-secret");
		expect(JSON.stringify(request)).not.toContain("partial");
		expect(sessionMessages(await storage.load()).slice(0, 3)).toEqual(history);
		expect(effects).toBe(0);
	} finally { await agent.dispose(); }
});

test("SDK saves consumed input before the model and retains it after cancellation", async () => {
	const storage = new MemorySessionStorage();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const model = scriptedModel({
		contextWindow: 100000,
		async stream(_messages, signal) {
			started();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", timestamp: 2 };
		},
	});
	const agent = await createAgent({ ...options, ...model, storage });
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
