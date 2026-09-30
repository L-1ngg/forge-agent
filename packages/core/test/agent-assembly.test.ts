import * as core from "../src/index.ts";
import { expect, test } from "bun:test";
import { createAgent } from "../src/sdk.ts";
import { RequestBus } from "../src/request-bus.ts";
import { MemorySessionStorage } from "../src/session-storage.ts";
import { fauxModel } from "../../../tests/support/model.ts";
import { nativeAdapter } from "../../../tests/fixtures/native-adapter.ts";
import { gate } from "../../../tests/fixtures/model-response.ts";

const options = { systemPrompt: "", cwd: process.cwd() };

test("SDK rejects the removed execution factory before loading storage or calling a model", async () => {
	expect("createSessionPort" in core).toBe(false);
	expect("createTestAgent" in core).toBe(false);
	let loads = 0, calls = 0, factories = 0;
	const model = fauxModel({ responses: [{ text: "must not run" }] });
	const configuration = { ...options, ...model, adapter: nativeAdapter(model.model, request => { calls++; return model.adapter.chatStream(request); }), storage: { load: async () => { loads++; return { entries: [], leafId: null }; }, append: async () => {} } };
	// @ts-expect-error Public creation accepts only options, including adapter/storage/tools.
	await expect(createAgent(configuration, () => { factories++; })).rejects.toThrow("one options argument");
	expect([loads, calls, factories]).toEqual([0, 0, 0]);
});

test("SDK waits for storage attachment before returning and persists through that storage", async () => {
	const entered = gate(); const release = gate(); const memory = new MemorySessionStorage();
	let loads = 0, calls = 0, returned = false;
	const model = fauxModel({ responses: [{ text: "saved answer" }] });
	const creating = createAgent({ ...options, ...model,
		adapter: nativeAdapter(model.model, request => { calls++; return model.adapter.chatStream(request); }),
		storage: { async load() { loads++; entered.resolve(); await release.promise; return memory.load(); }, append: entry => memory.append(entry) },
	}).then(agent => { returned = true; return agent; });
	try {
		await entered.promise;
		expect(returned).toBe(false); expect(loads).toBe(1); expect(calls).toBe(0); expect((await memory.load()).entries).toHaveLength(0);
	} finally { release.resolve(); }
	const agent = await creating;
	try {
		for await (const _ of agent.runTurn("hello")) {}
		expect(calls).toBe(1); expect(loads).toBe(1); expect((await memory.load()).entries).toHaveLength(2);
	} finally { await agent.dispose(); }
});

test("SDK storage load failure preserves the error and external request bus", async () => {
	const failure = new Error("storage unavailable"); const bus = new RequestBus();
	let loads = 0, calls = 0, writes = 0;
	const model = fauxModel({ responses: [{ text: "must not run" }] });
	try {
		await expect(createAgent({ ...options, ...model, requestBus: bus,
			adapter: nativeAdapter(model.model, request => { calls++; return model.adapter.chatStream(request); }),
			storage: { async load() { loads++; throw failure; }, async append() { writes++; } },
		})).rejects.toBe(failure);
		expect([loads, calls, writes]).toEqual([1, 0, 0]);
		const pending = bus.ask("cancel_confirm", { action: "cancel" }, { timeoutMs: null });
		expect(bus.pendingCount).toBe(1); bus.abort();
		expect(await pending).toMatchObject({ status: "cancelled", reason: "aborted" });
	} finally { bus.close(); }
});
