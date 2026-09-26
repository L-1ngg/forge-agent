import * as core from "../src/index.ts";
import { expect, test } from "bun:test";
import { createAgent } from "../src/sdk.ts";
import { RequestBus } from "../src/request-bus.ts";
import { MemorySessionStorage } from "../src/session-storage.ts";
import { fauxModel } from "../../../tests/support/model.ts";
import { gate } from "./helpers/model-response.ts";

const options = { systemPrompt: "", cwd: process.cwd() };

test("SDK rejects the removed execution factory before loading storage or calling a model", async () => {
	expect("createSessionPort" in core).toBe(false);
	expect("createTestPort" in core).toBe(false);
	let loads = 0, calls = 0, factories = 0;
	const model = fauxModel({ responses: [{ text: "must not run" }] });
	const configuration = { ...options, ...model, streamFn: (...args: Parameters<typeof model.streamFn>) => { calls++; return model.streamFn(...args); }, storage: { load: async () => { loads++; return { entries: [], leafId: null }; }, append: async () => {} } };
	// @ts-expect-error Public creation accepts only options, including streamFn/storage/tools.
	await expect(createAgent(configuration, () => { factories++; })).rejects.toThrow("one options argument");
	expect([loads, calls, factories]).toEqual([0, 0, 0]);
});

test("SDK waits for storage attachment before returning and persists through that storage", async () => {
	const entered = gate(); const release = gate(); const memory = new MemorySessionStorage();
	let loads = 0, calls = 0, returned = false;
	const model = fauxModel({ responses: [{ text: "saved answer" }] });
	const creating = createAgent({ ...options, ...model,
		streamFn: (...args) => { calls++; return model.streamFn(...args); },
		storage: { async load() { if (++loads === 2) { entered.resolve(); await release.promise; } return memory.load(); }, append: entry => memory.append(entry) },
	}).then(agent => { returned = true; return agent; });
	try {
		await entered.promise;
		expect(returned).toBe(false); expect(calls).toBe(0); expect((await memory.load()).entries).toHaveLength(0);
	} finally { release.resolve(); }
	const agent = await creating;
	try {
		for await (const _ of agent.runTurn("hello")) {}
		expect(calls).toBe(1); expect((await memory.load()).entries).toHaveLength(2);
	} finally { await agent.dispose(); }
});

for (const failureAt of [1, 2]) test(`SDK storage load failure preserves the error and external request bus; load=${failureAt}`, async () => {
	const failure = new Error("storage unavailable"); const bus = new RequestBus();
	let loads = 0, calls = 0, writes = 0;
	const model = fauxModel({ responses: [{ text: "must not run" }] });
	try {
		await expect(createAgent({ ...options, ...model, requestBus: bus,
			streamFn: (...args) => { calls++; return model.streamFn(...args); },
			storage: { async load() { if (++loads === failureAt) throw failure; return { entries: [], leafId: null }; }, async append() { writes++; } },
		})).rejects.toBe(failure);
		expect([calls, writes]).toEqual([0, 0]);
		const pending = bus.ask("cancel_confirm", { action: "cancel" }, { timeoutMs: null });
		expect(bus.pendingCount).toBe(1); bus.abort();
		expect(await pending).toMatchObject({ status: "cancelled", reason: "aborted" });
	} finally { bus.close(); }
});
