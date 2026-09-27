import { expect, test } from "bun:test";
import type { SessionEvent, SessionMessage } from "../../packages/protocol/src/index.ts";
import type { HarnessTool, ToolContext } from "../../packages/tools/src/index.ts";
import { createAgent, MemorySessionStorage, type AgentTurn } from "../../packages/core/src/sdk.ts";
import { sessionMessages } from "../../packages/core/src/session-storage.ts";
import { gate } from "../../packages/core/test/helpers/model-response.ts";
import { nativeAdapter, responseChunks } from "../../packages/core/test/helpers/native-adapter.ts";
import { createTestAgent } from "../support/test-agent.ts";
import { fauxModel } from "../support/model.ts";

const permission = { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] };
const parameters = { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
const answer: SessionMessage = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 1 };
const toolCalls = (names: string[]) => names.map((name, index) => ({ id: `call-${index}`, name, arguments: {} }));
async function collect(turn: AgentTurn): Promise<SessionEvent[]> {
	const events: SessionEvent[] = [];
	for await (const event of turn) events.push(event);
	return events;
}

// These assertions originated in the deleted Pi runtime tests. They exercise
// the public SDK and actual native chat loop without accessing internal state.
test("tool argument preparation runs before strict validation and authorization", async () => {
	const prepared: unknown[] = [], authorized: object[] = [], executed: object[] = [];
	const agent = await createTestAgent({
		permission: { hooks: [{ evaluate(call) { authorized.push(structuredClone(call.arguments)); return { kind: "allow", source: "hook" }; } }] },
		tools: [{ name: "normalize", label: "Normalize", description: "normalize", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
			prepareArguments(args) {
				prepared.push(structuredClone(args));
				if (!args || typeof args !== "object") throw new Error("Expected an argument object");
				return { value: Reflect.get(args, "legacyValue") };
			},
			async execute(args) { executed.push(structuredClone(args)); return { content: [], details: {} }; },
		}],
		responses: [{ toolCalls: [{ id: "valid", name: "normalize", arguments: { legacyValue: "prepared" } }, { id: "invalid", name: "normalize", arguments: { legacyValue: 3 } }] }, { text: "done" }],
	});
	const turn = agent.runTurn("normalize"); const events = await collect(turn);
	expect(await turn.result).toEqual({ status: "success" });
	expect(prepared).toEqual([{ legacyValue: "prepared" }, { legacyValue: 3 }]);
	expect(authorized).toEqual([{ value: "prepared" }]);
	expect(executed).toEqual([{ value: "prepared" }]);
	const ends = events.filter(event => event.type === "tool_execution_end");
	expect(ends.find(event => event.toolCallId === "valid")).toMatchObject({ isError: false });
	expect(ends.find(event => event.toolCallId === "invalid")).toMatchObject({ isError: true });
});

test("native loop emits tool completion order but commits results in call order before steering", async () => {
	const releaseFirst = gate();
	const storage = new MemorySessionStorage();
	let secondOverlapped = false, firstFinished = false;
	const agent = await createTestAgent({
		permission, storage,
		tools: [{ name: "work", label: "Work", description: "work", parameters, async execute(_input, context) {
			if (context.toolCallId === "call-0") { await releaseFirst.promise; firstFinished = true; }
			else secondOverlapped = !firstFinished;
			return { content: [{ type: "text", text: context.toolCallId! }], details: {} };
		} }],
		responses: [{ toolCalls: toolCalls(["work", "work"]) }, { echoLastUser: true }],
	});
	const turn = agent.runTurn("initial"); const events: SessionEvent[] = [];
	let processed: Promise<boolean> | undefined;
	try {
		for await (const event of turn) {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				const receipt = agent.steer("after complete batch", turn.id);
				expect(receipt.accepted).toBe(true);
				if (receipt.accepted) processed = receipt.processed;
				releaseFirst.resolve();
			}
		}
		expect(await turn.result).toEqual({ status: "success" });
		expect(await processed).toBe(true);
		expect(secondOverlapped).toBe(true);
		expect(events.flatMap(event => event.type === "tool_execution_end" ? [event.toolCallId] : [])).toEqual(["call-1", "call-0"]);
		expect(events.flatMap(event => event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [])).toEqual(["call-0", "call-1"]);
		const saved = sessionMessages(await storage.load());
		expect(saved.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user", "assistant"]);
		expect(saved.filter(message => message.role === "toolResult").map(message => message.toolCallId)).toEqual(["call-0", "call-1"]);
		expect(saved.at(-1)?.content).toEqual([{ type: "text", text: "after complete batch" }]);
	} finally { releaseFirst.resolve(); await agent.dispose(); }
});

for (const sameTool of [true, false]) test(`one sequential tool serializes the full native batch; sameTool=${sameTool}`, async () => {
	const firstStarted = gate(); const releaseFirst = gate();
	const effects: string[] = [];
	const execute: HarnessTool<object, unknown>["execute"] = async (_input, context) => {
		effects.push(`start:${context.toolCallId}`);
		if (context.toolCallId === "call-0") { firstStarted.resolve(); await releaseFirst.promise; }
		effects.push(`end:${context.toolCallId}`);
		return { content: [], details: {} };
	};
	const agent = await createTestAgent({
		permission,
		tools: [{ name: "serial", label: "Serial", description: "serial", parameters, executionMode: "sequential", execute }, { name: "parallel", label: "Parallel", description: "parallel", parameters, executionMode: "parallel", execute }],
		responses: [{ toolCalls: toolCalls(["serial", sameTool ? "serial" : "parallel"]) }, { text: "done" }],
	});
	const turn = agent.runTurn("batch"); const running = collect(turn);
	try {
		await firstStarted.promise;
		expect(effects).toEqual(["start:call-0"]);
		releaseFirst.resolve(); await running;
		expect(await turn.result).toEqual({ status: "success" });
		expect(effects).toEqual(["start:call-0", "end:call-0", "start:call-1", "end:call-1"]);
	} finally { releaseFirst.resolve(); await running; await agent.dispose(); }
});

test("settled tool progress is ignored while a sibling still runs and after invocation completion", async () => {
	const releaseSlow = gate();
	let update: ToolContext["onUpdate"];
	let slowFinished = false;
	const agent = await createTestAgent({
		permission,
		tools: [{ name: "work", label: "Work", description: "work", parameters, async execute(_input, context) {
			if (context.toolCallId === "call-0") {
				update = context.onUpdate;
				update?.({ content: [{ type: "text", text: "working" }], details: {} });
			} else { await releaseSlow.promise; slowFinished = true; }
			return { content: [], details: {} };
		} }],
		responses: [{ toolCalls: toolCalls(["work", "work"]) }, { text: "done" }, { text: "fresh" }],
	});
	const events: SessionEvent[] = [];
	try {
		for await (const event of agent.runTurn("batch")) {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-0") {
				expect(slowFinished).toBe(false);
				update?.({ content: [{ type: "text", text: "late during sibling" }], details: {} });
				releaseSlow.resolve();
			}
		}
		expect(events.filter(event => event.type === "tool_execution_update")).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("late during sibling");
		update?.({ content: [{ type: "text", text: "late after turn" }], details: {} });
		const fresh = await collect(agent.runTurn("fresh"));
		expect(fresh.filter(event => event.type === "tool_execution_update")).toHaveLength(0);
		expect(JSON.stringify(fresh)).not.toContain("late after turn");
	} finally { releaseSlow.resolve(); await agent.dispose(); }
});

for (const source of ["tool", "before", "after"] as const) for (const all of [false, true]) test(`native batch termination requires every result; source=${source}, all=${all}`, async () => {
	const storage = new MemorySessionStorage(); const effects: string[] = [];
	const terminate = (id: string) => all || id === "call-0";
	const agent = await createTestAgent({
		permission, storage,
		toolHooks: {
			beforeToolCall: async ({ toolCall }) => source === "before" && terminate(toolCall.id) ? { block: true, reason: "host stopped this call", terminate: true } : undefined,
			afterToolCall: async ({ toolCall }) => source === "after" ? { terminate: terminate(toolCall.id) } : undefined,
		},
		tools: [{ name: "work", label: "Work", description: "work", parameters, async execute(_input, context) {
			effects.push(context.toolCallId!);
			return { content: [], details: {}, ...(source === "tool" ? { terminate: terminate(context.toolCallId!) } : {}) };
		} }],
		responses: [{ toolCalls: toolCalls(["work", "work"]) }, { text: "continued" }],
	});
	const turn = agent.runTurn("batch"); const events = await collect(turn);
	expect(await turn.result).toEqual({ status: "success" });
	expect(effects).toEqual(source === "before" ? all ? [] : ["call-1"] : ["call-0", "call-1"]);
	expect(events.flatMap(event => event.type === "turn_end" ? [event.stopReason] : [])).toEqual(all ? ["tool_use"] : ["tool_use", "stop"]);
	const saved = sessionMessages(await storage.load());
	expect(saved.filter(message => message.role === "toolResult").map(message => message.toolCallId)).toEqual(["call-0", "call-1"]);
	expect(saved.filter(message => message.role === "assistant")).toHaveLength(all ? 1 : 2);
});

test("native continuation consumes persisted user context without duplicating its events or storage", async () => {
	const input: SessionMessage = { role: "user", content: [{ type: "text", text: "stored task" }], timestamp: 1 };
	const storage = new MemorySessionStorage([input]);
	const agent = await createTestAgent({ storage, responses: [{ echoLastUser: true }] });
	const turn = agent.continue(); const events = await collect(turn);
	expect(await turn.result).toEqual({ status: "success" });
	expect(events.filter(event => event.type === "message_end" && event.message.role === "user")).toHaveLength(0);
	expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(1);
	const saved = sessionMessages(await storage.load());
	expect(saved).toHaveLength(2); expect(saved[0]).toEqual(input);
	expect(saved[1]?.content).toEqual([{ type: "text", text: "stored task" }]);
});

for (const queue of ["steer", "followUp"] as const) test(`native continuation from an assistant tail preserves one-at-a-time ${queue} receipts`, async () => {
	const storage = new MemorySessionStorage([{ role: "user", content: [{ type: "text", text: "initial" }], timestamp: 1 }, answer]);
	const initial = sessionMessages(await storage.load());
	const agent = await createTestAgent({ storage, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", tokensPerSecond: 1000, responses: [{ text: "continue" }, { echoLastUser: true }, { echoLastUser: true }] });
	const turn = agent.continue(); const processed: Promise<boolean>[] = []; let queued = false;
	for await (const event of turn) {
		if (event.type === "message_delta" && !queued) {
			queued = true;
			for (const input of ["first queued", "second queued"]) {
				const receipt = agent[queue](input, turn.id);
				expect(receipt.accepted).toBe(true);
				if (receipt.accepted) processed.push(receipt.processed);
			}
		}
	}
	expect(await turn.result).toEqual({ status: "success" });
	expect(await Promise.all(processed)).toEqual([true, true]);
	const saved = sessionMessages(await storage.load());
	expect(saved.slice(0, 2)).toEqual(initial);
	expect(saved.slice(-4).map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	expect(saved.slice(-4).map(message => message.content)).toEqual(["first queued", "first queued", "second queued", "second queued"].map(text => [{ type: "text", text }]));
});

test("native continuation without history settles an error without calling an adapter", async () => {
	let calls = 0; const model = fauxModel({ responses: [] }).model;
	const agent = await createAgent({ cwd: process.cwd(), systemPrompt: "", model, adapter: nativeAdapter(model, async function* () { calls++; yield* responseChunks(answer); }) });
	try {
		const turn = agent.continue(); const events = await collect(turn);
		expect(await turn.result).toEqual({ status: "error" }); expect(calls).toBe(0);
		expect(events.filter(event => event.type === "message_end")).toMatchObject([{ message: { role: "assistant", stopReason: "error", errorMessage: "Cannot continue: no messages in context" } }]);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", outcome: "error" });
	} finally { await agent.dispose(); }
});

test("native waitForIdle waits for the durable assistant commit", async () => {
	const saving = gate(); const release = gate(); const memory = new MemorySessionStorage();
	const agent = await createTestAgent({
		responses: [{ text: "saved answer" }],
		storage: { load: () => memory.load(), async append(entry) {
			if (entry.type === "message" && entry.message.role === "assistant") { saving.resolve(); await release.promise; }
			await memory.append(entry);
		} },
	});
	const turn = agent.runTurn("work"); const running = collect(turn);
	try {
		await saving.promise;
		let idle = false; const idleResult = agent.waitForIdle().then(() => { idle = true; });
		await Promise.resolve(); expect(idle).toBe(false);
		expect(sessionMessages(await memory.load()).map(message => message.role)).toEqual(["user"]);
		release.resolve(); await running; await idleResult;
		expect(await turn.result).toEqual({ status: "success" });
		expect(sessionMessages(await memory.load()).map(message => message.role)).toEqual(["user", "assistant"]);
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("concurrent native continuation cannot cancel or alter the active invocation", async () => {
	const storage = new MemorySessionStorage();
	const agent = await createTestAgent({ storage, responses: [{ text: "complete active response" }], tokensPerSecond: 1000 });
	const turn = agent.runTurn("active"); let attempted = false;
	for await (const event of turn) {
		if (event.type === "message_delta" && !attempted) {
			attempted = true;
			await expect(collect(agent.continue())).rejects.toThrow("already");
		}
	}
	expect(attempted).toBe(true); expect(await turn.result).toEqual({ status: "success" });
	expect(sessionMessages(await storage.load())).toMatchObject([{ role: "user" }, { role: "assistant", content: [{ type: "text", text: "complete active response" }], stopReason: "stop" }]);
});

test("a throwing native adapter still completes the public error lifecycle and durable response", async () => {
	const model = fauxModel({ responses: [] }).model; const storage = new MemorySessionStorage();
	const agent = await createAgent({ cwd: process.cwd(), systemPrompt: "", model, storage, adapter: nativeAdapter(model, async function* () { throw new Error("provider exploded"); }) });
	try {
		const turn = agent.runTurn("hello"); const events = await collect(turn);
		expect(await turn.result).toEqual({ status: "error" });
		expect(events.filter(event => event.type === "turn_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_end")).toMatchObject([{ stopReason: "error" }]);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", outcome: "error" });
		expect(sessionMessages(await storage.load())).toMatchObject([{ role: "user" }, { role: "assistant", stopReason: "error", errorMessage: "provider exploded" }]);
	} finally { await agent.dispose(); }
});

test("native adapter receives the stable session identity for tasks and summaries", async () => {
	const model = fauxModel({ responses: [] }).model; const threads: Array<string | undefined> = [];
	const storage = new MemorySessionStorage([
		{ role: "user", content: [{ type: "text", text: "old goal" }], timestamp: 1 },
		{ ...answer, content: [{ type: "text", text: "old answer ".repeat(1000) }] },
		{ role: "user", content: [{ type: "text", text: "recent task" }], timestamp: 2 },
	]);
	const agent = await createAgent({ cwd: process.cwd(), systemPrompt: "", sessionId: "session-abc", model, storage, context: { enabled: false, keepRecentTokens: 1 }, adapter: nativeAdapter(model, async function* (request) {
		threads.push(request.threadId);
		yield* responseChunks({ ...answer, content: [{ type: "text", text: JSON.stringify({ states: [], claims: [], taskChanged: false }) }] });
	}) });
	try {
		expect(await agent.compact()).toMatchObject({ status: "complete" });
		const turn = agent.runTurn("hello"); await collect(turn);
		expect(await turn.result).toEqual({ status: "success" });
		expect(threads).toEqual(["session-abc", "session-abc"]);
	} finally { await agent.dispose(); }
});
