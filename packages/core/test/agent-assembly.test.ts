import { expect, test } from "bun:test";
import { createAgent, type CreateAgentOptions } from "../src/agent.ts";
import type { AgentPort } from "../src/agent-port.ts";
import { createPiTestPort } from "../src/pi-port.ts";
import { RequestBus } from "../src/request-bus.ts";
import { MemorySessionStorage } from "../src/session-storage.ts";

const options: CreateAgentOptions = { provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd() };
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

// Delegate to a real session; dynamic adapter damage must not damage its lifecycle.
function fixture() {
	const session = createPiTestPort({ responses: [{ text: "ok" }] });
	const calls = { storage: 0, run: 0, abort: 0, dispose: 0 };
	const port: AgentPort = {
		runTurn(input) { calls.run++; return session.runTurn(input); },
		continue: session.continue.bind(session),
		steer: session.steer.bind(session),
		followUp: session.followUp.bind(session),
		abort() { calls.abort++; session.abort(); },
		async dispose() { calls.dispose++; await session.dispose(); },
		getUsage: session.getUsage.bind(session),
		async setStorage(storage) { calls.storage++; await session.setStorage(storage); },
		compact: session.compact.bind(session),
		configureContext: session.configureContext.bind(session),
		updateConfiguration: session.updateConfiguration.bind(session),
	};
	return { port, calls, session };
}

for (const method of ["runTurn", "continue", "steer", "followUp", "abort", "dispose", "getUsage", "setStorage", "compact", "configureContext", "updateConfiguration"] as const) {
	for (const damage of ["missing", "non-callable"]) {
		test(`SDK rejects ${damage} ${method} during creation`, async () => {
			const { port, calls, session } = fixture();
			const storage = new MemorySessionStorage();
			if (damage === "missing") Reflect.deleteProperty(port, method);
			else Reflect.set(port, method, 42);
			try {
				await expect(createAgent({ ...options, storage }, () => port)).rejects.toThrow(`Agent factory must provide callable methods: ${method}`);
				expect(calls.storage).toBe(0);
				expect(calls.run).toBe(0);
				expect(calls.abort).toBe(method === "abort" ? 0 : 1);
				expect(calls.dispose).toBe(method === "dispose" ? 0 : 1);
				expect((await storage.load()).entries).toHaveLength(0);
			} finally { await session.dispose(); }
		});
	}
}

test("SDK rejects invalid factory results at both type and runtime boundaries", async () => {
	// @ts-expect-error An incomplete custom implementation is not an AgentPort.
	await expect(createAgent(options, () => ({ runTurn() {} }))).rejects.toThrow("callable methods");
	// @ts-expect-error JavaScript factories can return no instance.
	await expect(createAgent(options, () => undefined)).rejects.toThrow("callable methods");
});

test("SDK waits for storage attachment before returning a usable Agent", async () => {
	const { port, calls } = fixture();
	const entered = deferred();
	const gate = deferred();
	const attach = port.setStorage;
	port.setStorage = async storage => { entered.resolve(); await gate.promise; await attach(storage); };
	port.getUsage = () => undefined;
	const storage = new MemorySessionStorage();
	let returned = false;
	const creating = createAgent({ ...options, storage }, () => port).then(agent => { returned = true; return agent; });
	await entered.promise;
	expect(returned).toBe(false);
	expect(calls.run).toBe(0);
	expect((await storage.load()).entries).toHaveLength(0);
	gate.resolve();
	const agent = await creating;
	try {
		expect(agent.getUsage()).toBeUndefined();
		for await (const event of agent.runTurn("hello")) void event;
		expect((await storage.load()).entries).toHaveLength(2);
	} finally { await agent.dispose(); }
});

for (const external of [false, true]) {
	test(`SDK attachment failure awaits cleanup and respects ${external ? "external" : "internal"} bus ownership`, async () => {
		const { port, calls } = fixture();
		const failure = new Error("attachment failed");
		port.setStorage = async () => { throw failure; };
		const entered = deferred();
		const gate = deferred();
		const dispose = port.dispose;
		port.dispose = async () => { entered.resolve(); await gate.promise; await dispose(); };
		let bus = new RequestBus();
		let settled = false;
		const creating = createAgent({ ...options, ...(external ? { requestBus: bus } : {}) }, config => {
			bus = config.requestBus!;
			return port;
		}).catch(error => { settled = true; return error; });
		await entered.promise;
		expect(settled).toBe(false);
		expect(calls.abort).toBe(1);
		gate.resolve();
		expect(await creating).toBe(failure);
		expect(calls.dispose).toBe(1);
		const pending = bus.ask("cancel_confirm", { action: "cancel" }, { timeoutMs: null });
		expect(bus.pendingCount).toBe(external ? 1 : 0);
		bus.abort();
		expect(await pending).toMatchObject({ status: "cancelled", reason: external ? "aborted" : "bus_closed" });
		bus.close();
	});
}

test("SDK preserves the original error and all cleanup failures", async () => {
	const { port, session } = fixture();
	const original = new Error("storage");
	const abort = new Error("abort");
	const dispose = new Error("dispose");
	port.setStorage = async () => { throw original; };
	port.abort = () => { throw abort; };
	port.dispose = async () => { throw dispose; };
	try {
		const error = await createAgent(options, () => port).catch(error => error);
		expect(error).toBeInstanceOf(AggregateError);
		expect(error.cause).toBe(original);
		expect(error.errors).toEqual([original, abort, dispose]);
	} finally { await session.dispose(); }
});

test("SDK factory failure preserves the original error and closes its internal bus", async () => {
	const original = new Error("factory");
	let bus: RequestBus | undefined;
	await expect(createAgent(options, config => { bus = config.requestBus; throw original; })).rejects.toBe(original);
	expect(await bus!.ask("cancel_confirm", { action: "cancel" })).toMatchObject({ status: "cancelled", reason: "bus_closed" });
});
