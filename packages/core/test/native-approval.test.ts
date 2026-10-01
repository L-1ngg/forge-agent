import { expect, test } from "bun:test";
import { permissionScopeForToolCall, response } from "@forge-agent/protocol";
import { z } from "zod";
import { createAgent, LongTermMemory, MemorySessionStorage } from "@forge-agent/core/sdk";
import type { HarnessTool } from "@forge-agent/tools";
import { nativeAdapter, requestMessages, responseChunks } from "../../../tests/fixtures/native-adapter.ts";
import { isMemoryOrganizerRequest } from "../../../tests/fixtures/native-reply.ts";
import { EventType } from "@tanstack/ai";
import type { Model } from "../src/model-types.ts";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barrier, bounded } from "../../../tests/support/control.ts";

const model: Model = {
	id: "approval-fixture", name: "Approval fixture", api: "faux", provider: "faux", baseUrl: "http://localhost:0",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 16384,
};

test("native tool errors save their proposal before the next model request", async () => {
	const storage = new MemorySessionStorage();
	const requests: SessionMessage[][] = [];
	let effects = 0;
	const adapter = nativeAdapter(model, async function* (request) {
		requests.push(requestMessages(request.messages));
		if (requests.length === 1) {
			yield { type: EventType.TOOL_CALL_START, toolCallId: "bad", toolCallName: "work", parentMessageId: "answer" };
			yield { type: EventType.TOOL_CALL_ARGS, toolCallId: "bad", delta: '{"value":"x"}' };
			yield { type: EventType.TOOL_CALL_END, toolCallId: "bad", input: { value: "x" }, state: "output-error", result: "Provider rejected tool" };
			yield { type: EventType.RUN_FINISHED, threadId: "fixture", runId: "first", finishReason: "tool_calls" };
		} else yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now() });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(), storage,
		tools: [{ name: "work", label: "Work", description: "record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute() { effects++; return { content: [], details: {} }; } }],
	});
	try {
		const turn = agent.runTurn("work");
		for await (const _event of turn) {}
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toBe(0);
		expect(requests).toHaveLength(2);
		const saved = (await storage.load()).entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
		expect(saved.filter(message => message.role === "assistant" && message.content.some(part => part.type === "tool_call"))).toHaveLength(1);
		expect(saved.filter(message => message.role === "toolResult" && message.toolCallId === "bad")).toHaveLength(1);
	} finally { await agent.dispose(); }
});

test("provider-executed calls retain their metadata without a local missing-result record", async () => {
	const storage = new MemorySessionStorage();
	const requests: SessionMessage[][] = [];
	const adapter = nativeAdapter(model, async function* (request) {
		requests.push(requestMessages(request.messages));
		if (requests.length === 1) {
			yield { type: EventType.TOOL_CALL_START, toolCallId: "remote", toolCallName: "web_search", parentMessageId: "answer", metadata: { providerExecuted: true, sourceId: "citation-1" } };
			yield { type: EventType.TOOL_CALL_ARGS, toolCallId: "remote", delta: '{"query":"source"}' };
			yield { type: EventType.TOOL_CALL_END, toolCallId: "remote", input: { query: "source" } };
			yield { type: EventType.RUN_FINISHED, threadId: "fixture", runId: "first", finishReason: "tool_calls" };
		} else yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now() });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(), storage });
	try {
		const turn = agent.runTurn("search");
		for await (const _event of turn) {}
		expect(await turn.result).toEqual({ status: "success" });
		expect(requests).toHaveLength(2);
		const saved = (await storage.load()).entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
		expect(saved.filter(message => message.role === "toolResult")).toHaveLength(0);
		const proposal = saved.find(message => message.role === "assistant" && message.content.some(part => part.type === "tool_call"));
		expect(proposal?.content).toContainEqual(expect.objectContaining({ id: "remote", thoughtSignature: expect.stringContaining('"providerExecuted":true') }));
		expect(requests[1]?.find(message => message.role === "assistant" && message.content.some(part => part.type === "tool_call"))?.content).toContainEqual(expect.objectContaining({ id: "remote", thoughtSignature: expect.stringContaining('"sourceId":"citation-1"') }));
	} finally { await agent.dispose(); }
});

function fixture(requests: SessionMessage[][]) {
	let count = 0;
	return nativeAdapter(model, async function* (request) {
		requests.push(requestMessages(request.messages));
		const message: SessionMessage = count++ === 0
			? { role: "assistant", content: ["allow", "deny", "ask"].map(id => ({ type: "tool_call", id, name: "work", arguments: { value: id } })), stopReason: "tool_use", timestamp: Date.now() }
			: { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop", timestamp: Date.now() };
		yield* responseChunks(message);
	});
}

test("one native approval batch waits for ask, executes allowed calls once, and lets the model see denial", async () => {
	const requests: SessionMessage[][] = [], effects: string[] = [], sessionEvents: SessionEvent[] = [];
	const storage = new MemorySessionStorage();
	const tool: HarnessTool<object, unknown> = {
		name: "work", label: "Work", description: "record a value",
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
		async execute(args) { effects.push((args as { value: string }).value); return { content: [{ type: "text", text: JSON.stringify(args) }], details: args }; },
	};
	const agent = await createAgent({ model, adapter: fixture(requests), systemPrompt: "test", cwd: process.cwd(), storage, tools: [tool],
		permission: { hooks: [{ evaluate(call) {
			if (call.arguments.value === "allow") return { kind: "allow", source: "hook" };
			if (call.arguments.value === "deny") return { kind: "deny", source: "hook", reason: "policy denied" };
			return undefined;
		} }] },
	});
	const turn = agent.runTurn("work");
	const events = (async () => { for await (const event of turn) sessionEvents.push(event); })();
	try {
		const next = await agent.requests[Symbol.asyncIterator]().next();
		if (next.done || next.value.kind !== "permission") throw new Error("Expected a permission request");
		expect(next.value.payload.toolCall.arguments).toEqual({ value: "ask" });
		expect(effects).toEqual([]);
		expect(requests).toHaveLength(1);
		expect((await storage.load()).entries.filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(0);
		expect(agent.respond(response(next.value.id, { decision: "allow_once" }))).toBe(true);
		await events;
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toEqual(["allow", "ask"]);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain("policy denied");
		const saved = (await storage.load()).entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
		expect(saved.filter(message => message.role === "user")).toHaveLength(1);
		expect(saved.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(saved.filter(message => message.role === "toolResult")).toHaveLength(3);
		const proposalEnd = sessionEvents.findIndex(event => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some(part => part.type === "tool_call"));
		const firstTool = sessionEvents.findIndex(event => event.type === "tool_execution_start");
		const finalAnswer = sessionEvents.findIndex(event => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some(part => part.type === "text"));
		expect(proposalEnd).toBeGreaterThan(-1);
		expect(firstTool).toBeGreaterThan(-1);
		expect(proposalEnd).toBeGreaterThan(firstTool);
		expect(finalAnswer).toBeGreaterThan(firstTool);
		expect(sessionEvents.at(-1)?.type).toBe("agent_end");
	} finally { agent.abort(); await events; await agent.dispose(); }
});

test("an entirely denied batch returns reasons to the model and finishes the invocation", async () => {
	const requests: SessionMessage[][] = [], effects: string[] = [];
	const agent = await createAgent({ model, adapter: fixture(requests), systemPrompt: "test", cwd: process.cwd(),
		tools: [{ name: "work", label: "Work", description: "record a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String((args as { value: string }).value)); return { content: [], details: {} }; } }],
		permission: { mode: "deny-all" },
	});
	try {
		const turn = agent.runTurn("work");
		for await (const _event of turn) { }
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toEqual([]);
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1])).toContain("deny-all");
	} finally { await agent.dispose(); }
});

test("native approval sees defaults parsed by a Zod-backed host tool", async () => {
	const effects: string[] = [];
	let calls = 0;
	const adapter = nativeAdapter(model, async function* () {
		yield* responseChunks(++calls === 1
			? { role: "assistant", content: [{ type: "tool_call", id: "normalized", name: "work", arguments: {} }], stopReason: "tool_use", timestamp: calls }
			: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: calls });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(),
		tools: [{ name: "work", label: "Work", description: "record", inputSchema: z.object({ value: z.string().default("ready") }),
			parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { const value = (args as { value: string }).value; effects.push(value); return { content: [{ type: "text", text: value }], details: value }; } }],
	});
	const turn = agent.runTurn("work");
	const running = (async () => { for await (const _event of turn) {} })();
	try {
		const next = await bounded(agent.requests[Symbol.asyncIterator]().next(), "normalized approval", 1500);
		if (next.done || next.value.kind !== "permission") throw new Error("Expected permission request");
		expect(next.value.payload.toolCall.arguments).toEqual({ value: "ready" });
		expect(agent.respond(response(next.value.id, { decision: "allow_once" }))).toBe(true);
		await bounded(running, "normalized turn");
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toEqual(["ready"]);
		expect(calls).toBe(2);
	} finally { agent.abort(); await running; await agent.dispose(); }
});

test("a failing permission memory settles approval without executing the tool", async () => {
	const requests: SessionMessage[][] = [], effects: string[] = [];
	let calls = 0;
	const adapter = nativeAdapter(model, async function* (request) {
		requests.push(requestMessages(request.messages));
		yield* responseChunks(++calls === 1
			? { role: "assistant", content: [{ type: "tool_call", id: "ask", name: "work", arguments: { value: "ask" } }], stopReason: "tool_use", timestamp: calls }
			: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: calls });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(),
		tools: [{ name: "work", label: "Work", description: "record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String((args as { value: string }).value)); return { content: [], details: {} }; } }],
		permission: { memory: { match() { return undefined; }, remember() { throw new Error("memory unavailable"); }, entries() { return []; } } },
	});
	const turn = agent.runTurn("work");
	const running = (async () => { for await (const _event of turn) {} })();
	try {
		const next = await agent.requests[Symbol.asyncIterator]().next();
		if (next.done || next.value.kind !== "permission") throw new Error("Expected permission request");
		expect(agent.respond(response(next.value.id, { decision: "allow_always", scope: permissionScopeForToolCall(next.value.payload.toolCall) }))).toBe(true);
		await bounded(running, "failing permission memory", 1500);
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toEqual([]);
		expect(JSON.stringify(requests[1])).toContain("memory unavailable");
	} finally { agent.abort(); await running; await agent.dispose(); }
});

for (const schema of ["zod", "json"] as const) for (const edited of ["reviewed", "deny", 42] as const) test(`native ${schema} edited approval ${String(edited)} needs no Forge re-evaluation`, async () => {
	const requests: SessionMessage[][] = [], effects: string[] = [];
	const storage = new MemorySessionStorage();
	const evaluated: unknown[] = [];
	const agent = await createAgent({ model, adapter: fixture(requests), systemPrompt: "test", cwd: process.cwd(), storage,
		tools: [{ name: "work", label: "Work", description: "record a value", ...(schema === "zod" ? { inputSchema: z.strictObject({ value: z.string() }) } : {}), parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String((args as { value: string }).value)); return { content: [{ type: "text", text: "done" }], details: {} }; } }],
		permission: { hooks: [{ evaluate(call) {
			evaluated.push(call.arguments.value);
			if (call.arguments.value === "allow") return { kind: "allow", source: "hook" };
			if (call.arguments.value === "deny") return { kind: "deny", source: "hook", reason: "edited value denied" };
			return undefined;
		} }] },
	});
	const turn = agent.runTurn("work");
	const events = (async () => { for await (const _event of turn) { } })();
	try {
		const next = await agent.requests[Symbol.asyncIterator]().next();
		if (next.done || next.value.kind !== "permission") throw new Error("Expected a permission request");
		const result = { decision: "allow_once" as const, editedArgs: { value: edited } };
		expect(agent.respond(response(next.value.id, result))).toBe(true);
		expect(agent.respond(response(next.value.id, result))).toBe(false);
		await events;
		const saved = (await storage.load()).entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(evaluated).toEqual(["allow", "deny", "ask"]);
		expect((await storage.load()).entries.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.toolArguments)).toHaveLength(0);
		if (typeof edited === "string") {
			expect(await turn.result).toEqual({ status: "success" });
			expect(effects).toEqual(["allow", edited]);
			expect(saved.find(message => message.toolCallId === "ask")?.toolArguments).toEqual({ value: edited });
		} else {
			expect(await turn.result).toEqual({ status: "error" });
			expect(effects).toEqual([]);
			expect(requests).toHaveLength(1);
			expect(JSON.stringify(await storage.load())).toContain("edited arguments are invalid");
		}
	} finally { agent.abort(); await events; await agent.dispose(); }
});

test("stopping while approval is pending invalidates the old answer and does not execute tools", async () => {
	const requests: SessionMessage[][] = [], effects: string[] = [];
	const agent = await createAgent({ model, adapter: fixture(requests), systemPrompt: "test", cwd: process.cwd(),
		tools: [{ name: "work", label: "Work", description: "record a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String((args as { value: string }).value)); return { content: [], details: {} }; } }],
	});
	const turn = agent.runTurn("work");
	const events = (async () => { for await (const _event of turn) { } })();
	try {
		const next = await agent.requests[Symbol.asyncIterator]().next();
		if (next.done || next.value.kind !== "permission") throw new Error("Expected a permission request");
		agent.abort();
		await events;
		expect(await turn.result).toEqual({ status: "aborted" });
		expect(agent.respond(response(next.value.id, { decision: "allow_once" }))).toBe(false);
		expect(effects).toEqual([]);
		expect(requests).toHaveLength(1);
	} finally { agent.abort(); await events; await agent.dispose(); }
});

test("a native batch waits for every valid answer and ignores invalid or repeated replies", async () => {
	const effects: string[] = [], requests: SessionMessage[][] = [];
	let count = 0;
	const adapter = nativeAdapter(model, async function* (request) {
		requests.push(requestMessages(request.messages));
		yield* responseChunks(++count === 1
			? { role: "assistant", content: ["first", "second"].map(id => ({ type: "tool_call" as const, id, name: "work", arguments: { value: id } })), stopReason: "tool_use", timestamp: count }
			: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: count });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(),
		tools: [{ name: "work", label: "Work", description: "record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args) { effects.push(String((args as { value: string }).value)); return { content: [], details: {} }; } }],
	});
	const turn = agent.runTurn("work");
	const running = (async () => { for await (const _event of turn) {} })();
	try {
		const requestsStream = agent.requests[Symbol.asyncIterator]();
		const first = await requestsStream.next(), second = await requestsStream.next();
		if (first.done || second.done) throw new Error("Expected two permission requests");
		expect(effects).toEqual([]);
		expect(agent.respond({ type: "response", id: first.value.id, result: { decision: "allow_once", editedArgs: 3 } } as never)).toBe(false);
		expect(agent.respond(response(first.value.id, { decision: "allow_once" }))).toBe(true);
		expect(agent.respond(response(first.value.id, { decision: "allow_once" }))).toBe(false);
		await Promise.resolve();
		expect(effects).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(agent.respond(response(second.value.id, { decision: "allow_once" }))).toBe(true);
		await running;
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toEqual(["first", "second"]);
	} finally { agent.abort(); await running; await agent.dispose(); }
});

test("steering waits through approval and the approved tool retains its configuration", async () => {
	const requests: SessionMessage[][] = [], prompts: string[] = [], effects: string[] = [];
	let count = 0;
	const adapter = nativeAdapter(model, async function* (request) {
		requests.push(requestMessages(request.messages));
		prompts.push(JSON.stringify(request.systemPrompts));
		yield* responseChunks(++count === 1
			? { role: "assistant", content: [{ type: "tool_call", id: "held", name: "work", arguments: { value: "old" } }], stopReason: "tool_use", timestamp: count }
			: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: count });
	});
	const tool = (label: string): HarnessTool<object, unknown> => ({ name: "work", label, description: "record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
		async execute() { effects.push(label); return { content: [], details: {} }; } });
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ model, adapter, systemPrompt: "OLD", cwd: process.cwd(), storage, tools: [tool("old")] });
	const turn = agent.runTurn("first input");
	const running = (async () => { for await (const _event of turn) {} })();
	try {
		const pending = await agent.requests[Symbol.asyncIterator]().next();
		if (pending.done) throw new Error("Expected permission request");
		const receipt = agent.steer("while waiting", turn.id);
		expect(receipt.accepted).toBe(true);
		const update = await agent.updateConfiguration({ systemPrompt: "NEW", tools: [tool("new")] });
		let applied = false;
		void update.applied.then(() => { applied = true; });
		await Promise.resolve();
		expect(applied).toBe(false);
		expect(requests).toHaveLength(1);
		expect(agent.respond(response(pending.value.id, { decision: "allow_once" }))).toBe(true);
		await running;
		expect(await turn.result).toEqual({ status: "success" });
		expect(await (receipt.accepted ? receipt.processed : Promise.resolve(false))).toBe(true);
		expect(await update.applied).toMatchObject({ status: "applied" });
		expect(effects).toEqual(["old"]);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("OLD");
		expect(prompts[1]).toContain("NEW");
		expect(requests[1]!.filter(message => message.role === "user")).toHaveLength(2);
		expect((await storage.load()).entries.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
	} finally { agent.abort(); await running; await agent.dispose(); }
});

test("memory saves once after a native approval continuation", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-native-approval-memory-"));
	const requests: SessionMessage[][] = [], events: SessionEvent[] = [];
	let saves = 0;
	let organizerInput = "";
	const task = fixture(requests);
	const adapter = nativeAdapter(model, async function* (request) {
		if (isMemoryOrganizerRequest(request)) {
			saves++;
			organizerInput = JSON.stringify(request.messages);
			yield* responseChunks({ role: "assistant", content: [{ type: "text", text: '{"updates":[],"indexes":[]}' }], stopReason: "stop", timestamp: Date.now() });
		} else yield* task.chatStream(request);
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: root,
		memory: { store: new LongTermMemory({ project: root }) },
		tools: [{ name: "work", label: "Work", description: "record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute() { return { content: [{ type: "text", text: "Verified by tool" }], details: {} }; } }],
		permission: { hooks: [{ evaluate: call => call.arguments.value === "ask" ? undefined : { kind: "allow", source: "hook" } }] },
	});
	const turn = agent.runTurn("remember one task");
	const running = (async () => { for await (const event of turn) events.push(event); })();
	try {
		const pending = await agent.requests[Symbol.asyncIterator]().next();
		if (pending.done) throw new Error("Expected permission request");
		expect(saves).toBe(0);
		expect(agent.respond(response(pending.value.id, { decision: "allow_once" }))).toBe(true);
		await running;
		expect(await turn.result).toEqual({ status: "success" });
		expect(requests).toHaveLength(2);
		expect(saves).toBe(1);
		expect(organizerInput).toContain("Verified by tool");
		expect(events.filter(event => event.type === "memory" && event.phase === "save")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
	} finally { agent.abort(); await running; await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("stopping a running native tool waits for cleanup and never starts its successor", async () => {
	const started = barrier("first tool started"), release = barrier("first tool released");
	const effects: string[] = [], storage = new MemorySessionStorage();
	let count = 0;
	const adapter = nativeAdapter(model, async function* () {
		yield* responseChunks(++count === 1
			? { role: "assistant", content: ["first", "second"].map(id => ({ type: "tool_call" as const, id, name: "work", arguments: { value: id } })), stopReason: "tool_use", timestamp: count }
			: { role: "assistant", content: [{ type: "text", text: "unexpected" }], stopReason: "stop", timestamp: count });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(), storage,
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "work", label: "Work", description: "record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			async execute(args, context) {
				const value = String((args as { value: string }).value);
				effects.push(value);
				if (value === "first") { started.release(); await release.wait(); expect(context.signal?.aborted).toBe(true); }
				return { content: [{ type: "text", text: value }], details: {} };
			} }],
	});
	const turn = agent.runTurn("stop");
	const running = (async () => { for await (const _event of turn) {} })();
	try {
		await started.wait();
		agent.abort();
		expect(effects).toEqual(["first"]);
		release.release();
		await bounded(running, "native stop");
		expect(await turn.result).toEqual({ status: "aborted" });
		expect(effects).toEqual(["first"]);
		const saved = (await storage.load()).entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(saved.map(message => message.toolCallId)).toEqual(["first", "second"]);
		expect(saved[1]?.isError).toBe(true);
		expect(count).toBe(1);
	} finally { release.release(); agent.abort(); await running; await agent.dispose(); }
});

test("a late approval cannot authorize a later invocation", async () => {
	const effects: string[] = [];
	let count = 0;
	const adapter = nativeAdapter(model, async function* () {
		yield* responseChunks(++count <= 2
			? { role: "assistant", content: [{ type: "tool_call", id: `call-${count}`, name: "work", arguments: {} }], stopReason: "tool_use", timestamp: count }
			: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: count });
	});
	const agent = await createAgent({ model, adapter, systemPrompt: "test", cwd: process.cwd(),
		tools: [{ name: "work", label: "Work", description: "record", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute() { effects.push("ran"); return { content: [], details: {} }; } }],
	});
	try {
		const first = agent.runTurn("first");
		const firstRun = (async () => { for await (const _event of first) {} })();
		const requests = agent.requests[Symbol.asyncIterator]();
		const old = await requests.next(); if (old.done) throw new Error("Expected first approval");
		agent.abort(); await firstRun;
		expect(await first.result).toEqual({ status: "aborted" });
		const second = agent.runTurn("second");
		const secondRun = (async () => { for await (const _event of second) {} })();
		const fresh = await requests.next(); if (fresh.done) throw new Error("Expected second approval");
		expect(fresh.value.id).not.toBe(old.value.id);
		expect(agent.respond(response(old.value.id, { decision: "allow_once" }))).toBe(false);
		expect(effects).toEqual([]);
		expect(agent.respond(response(fresh.value.id, { decision: "allow_once" }))).toBe(true);
		await secondRun;
		expect(await second.result).toEqual({ status: "success" });
		expect(effects).toEqual(["ran"]);
	} finally { agent.abort(); await agent.dispose(); }
});
