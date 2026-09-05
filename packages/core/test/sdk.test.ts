import { expect, test } from "bun:test";
import fc from "fast-check";
import { createAgent, type CreateAgentOptions } from "../src/agent.ts";
import { createPiTestPort } from "../src/pi-port.ts";
import { MemorySessionStorage } from "../src/session-storage.ts";
import { response } from "@forge-agent/protocol";

const options: CreateAgentOptions = { provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd() };

test("SDK disposal remains terminal across generated queued inputs and cancellation", async () => {
	await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("steer", "followUp", "abort"), { maxLength: 12 }), async (actions) => {
		const storage = new MemorySessionStorage();
		const agent = await createAgent({ ...options, storage }, () => createPiTestPort({ responses: [{ text: "streaming output" }], tokensPerSecond: 100 }));
		const turn = agent.runTurn("hello");
		const iterator = turn[Symbol.asyncIterator]();
		await iterator.next();
		for (const action of actions) {
			if (action === "abort") agent.abort();
			else agent[action]("queued", turn.id);
		}
		await agent.dispose();
		await agent.dispose();
		expect(await storage.load()).toHaveLength(0);
		expect((await iterator.next()).done).toBe(true);
		expect(agent.getUsage()).toBeUndefined();
		expect(() => agent.runTurn("late")).toThrow("disposed");
	}), { numRuns: 20, seed: 90502 });
});

test("SDK commits complete calls but not a consumer break at agent_end", async () => {
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...options, storage }, () => createPiTestPort({ responses: [{ text: "first" }, { text: "second" }] }));
	const initialUsage = agent.getUsage()?.contextTokens;
	for await (const event of agent.runTurn("first")) {
		if (event.type === "agent_end") break;
	}
	expect(await storage.load()).toHaveLength(0);
	expect(agent.getUsage()?.contextTokens).toBe(initialUsage);
	for await (const event of agent.runTurn("second")) void event;
	expect(await storage.load()).toHaveLength(2);
	await agent.dispose();
});

test("SDK dispose aborts streaming while the event consumer is paused", async () => {
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...options, storage }, () => createPiTestPort({ responses: [{ text: "very long output" }], tokensPerSecond: 1 }));
	const iterator = agent.runTurn("hello")[Symbol.asyncIterator]();
	await iterator.next();
	const disposing = agent.dispose();
	expect(agent.dispose()).toBe(disposing);
	await disposing;
	expect(await storage.load()).toHaveLength(0);
	expect(() => agent.runTurn("again")).toThrow("disposed");
	expect(() => agent.steer("again", Symbol())).toThrow("disposed");
	expect(() => agent.followUp("again", Symbol())).toThrow("disposed");
	expect((await iterator.next()).done).toBe(true);
});

test("SDK default permission waits for host response and dispose closes requests", async () => {
	let executions = 0;
	const agent = await createAgent(options, (config) => createPiTestPort({
		...config,
		tools: [{ name: "custom", label: "Custom", description: "Custom", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, execute: async () => { executions++; return { ok: true, value: "ok" }; } }],
		responses: [{ toolCalls: [{ id: "call", name: "custom", arguments: {} }] }, { text: "done" }],
	}));
	const events = (async () => { for await (const event of agent.runTurn("hello")) void event; })();
	const requests = agent.requests[Symbol.asyncIterator]();
	const request = await requests.next();
	expect(executions).toBe(0);
	if (request.done) throw new Error("missing permission");
	expect(agent.respond(response(request.value.id, { decision: "allow_once" }))).toBe(true);
	await events;
	expect(executions).toBe(1);
	await agent.dispose();
	expect((await requests.next()).done).toBe(true);
});

test("SDK rejects reuse after storage commit failure", async () => {
	const agent = await createAgent({ ...options, storage: { load: async () => [], appendTurn: async () => { throw new Error("disk failed"); } } }, () => createPiTestPort({ responses: [{ text: "done" }] }));
	const consume = async () => { for await (const event of agent.runTurn("hello")) void event; };
	await expect(consume()).rejects.toThrow("disk failed");
	expect(() => agent.runTurn("again")).toThrow("faulted");
	expect(() => agent.followUp("again", Symbol())).toThrow("faulted");
	await agent.dispose();
});

test("SDK stale iterator return cannot cancel a newer invocation", async () => {
	const agent = await createAgent(options, () => createPiTestPort({ responses: [{ text: "first" }, { text: "second" }] }));
	const old = agent.runTurn("first")[Symbol.asyncIterator]();
	while (!(await old.next()).done) {}
	const current = agent.runTurn("second")[Symbol.asyncIterator]();
	await current.next();
	await old.return?.();
	let stopReason: string | undefined;
	while (true) {
		const event = await current.next();
		if (event.done) break;
		if (event.value.type === "turn_end") stopReason = event.value.stopReason;
	}
	expect(stopReason).toBe("stop");
	await agent.dispose();
});

test("SDK disposed unstarted iterators cannot launch a model", async () => {
	let runs = 0;
	const agent = await createAgent(options, () => ({
		async *runTurn() { runs++; }, steer() { return { accepted: false }; }, followUp() { return { accepted: false }; }, abort() {},
	}));
	const iterator = agent.runTurn("first")[Symbol.asyncIterator]();
	await agent.dispose();
	expect((await iterator.next()).done).toBe(true);
	expect(runs).toBe(0);
});

test("SDK dispose cancels a pending permission without executing the tool", async () => {
	let executions = 0;
	const agent = await createAgent(options, (config) => createPiTestPort({
		...config,
		tools: [{ name: "custom", label: "Custom", description: "Custom", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, execute: async () => { executions++; return { ok: true, value: "ok" }; } }],
		responses: [{ toolCalls: [{ id: "call", name: "custom", arguments: {} }] }],
	}));
	const iterator = agent.runTurn("hello")[Symbol.asyncIterator]();
	await iterator.next();
	const requests = agent.requests[Symbol.asyncIterator]();
	expect((await requests.next()).done).toBe(false);
	await agent.dispose();
	expect(executions).toBe(0);
	expect((await requests.next()).done).toBe(true);
});

test("SDK dispose waits for cooperative tool cleanup with paused event consumption", async () => {
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
	let cleaned = false;
	const agent = await createAgent({ ...options, permission: { rules: [{ tool: "hold", argsPattern: "*", effect: "allow" }] } }, (config) => createPiTestPort({
		...config,
		tools: [{ name: "hold", label: "Hold", description: "Hold", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute(_input, context) {
			notifyStarted();
			await new Promise<void>((resolve) => { context.signal?.addEventListener("abort", () => resolve(), { once: true }); });
			await Bun.sleep(5);
			cleaned = true;
			return { ok: true, value: "done" };
		} }],
		responses: [{ toolCalls: [{ id: "call", name: "hold", arguments: {} }] }],
	}));
	const iterator = agent.runTurn("hello")[Symbol.asyncIterator]();
	await iterator.next();
	await started;
	await agent.dispose();
	expect(cleaned).toBe(true);
});
