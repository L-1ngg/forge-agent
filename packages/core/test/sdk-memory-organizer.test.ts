import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType, type AdapterYieldChunk } from "@tanstack/ai";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { SessionEvent } from "@forge-agent/protocol";
import { createAgent, LongTermMemory, type Agent } from "../src/sdk.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import type { Model } from "../src/model-types.ts";
import { processConverseStream } from "../node_modules/@tanstack/ai-bedrock/dist/esm/converse/stream-processor.js";
import { nativeAdapter, type NativeStream } from "../../../tests/fixtures/native-adapter.ts";
import { isMemoryOrganizerRequest, nativeReply } from "../../../tests/fixtures/native-reply.ts";
import { barrier, bounded } from "../../../tests/support/control.ts";
import { withScenario } from "../../../tests/support/scenario.ts";

const model = getCatalogModel("openai", "gpt-5.4")!;
const validPlan = JSON.stringify({ updates: [{ action: "write", scope: "project", path: "topic.md", content: "Durable note" }], indexes: [] });

for (const fixture of [
	{ name: "host window", model, contextWindow: 4096, thinkingLevel: "off", rejected: true },
	{ name: "model window", model: { ...model, contextWindow: 4096 }, thinkingLevel: "off", rejected: true },
	{ name: "reasoning output reserve", model: getCatalogModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 13000, thinkingLevel: "medium", rejected: true },
	{ name: "sufficient window", model, contextWindow: 64000, thinkingLevel: "off", rejected: false },
] as const) test(`organizer input budgets preserve task success and existing memory: ${fixture.name}`, () => withScenario(`organizer-budget-${fixture.name}`, async scenario => {
	const project = join(scenario.directory, "project-memory"), user = join(scenario.directory, "user-memory");
	await Promise.all([mkdir(project), mkdir(user)]);
	const index = "[Topic](topic.md)\n" + "index ".repeat(980), topic = "topic ".repeat(1000);
	await Promise.all([project, user].flatMap(root => [writeFile(join(root, "MEMORY.md"), index), writeFile(join(root, "topic.md"), topic)]));
	let organizerRequests = 0;
	const adapter = nativeAdapter(fixture.model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		if (organizer) organizerRequests++;
		yield* nativeReply({ text: organizer ? validPlan : "Task complete" });
	});
	const agent = await scenario.agent({
		model: fixture.model, adapter, maxTokens: 512, thinkingLevel: fixture.thinkingLevel,
		...("contextWindow" in fixture ? { contextWindow: fixture.contextWindow } : {}),
		memory: { store: new LongTermMemory({ project, user }), injection: false },
	});
	const turn = agent.runTurn("Remember a durable preference"), events = await scenario.collect(turn);
	expect(await turn.result).toEqual({ status: "success" });
	expect(organizerRequests).toBe(fixture.rejected ? 0 : 1);
	expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject(fixture.rejected
		? { status: "failed", calls: 0, receipts: [{ ok: false, error: expect.stringContaining("request-budget") }] }
		: { status: "saved", calls: 1 });
	expect(await Bun.file(join(project, "topic.md")).text()).toEqual(fixture.rejected ? topic : expect.stringContaining("Durable note"));
	expect(await Bun.file(join(user, "topic.md")).text()).toBe(topic);
	for (const root of [project, user]) {
		expect(await Bun.file(join(root, "MEMORY.md")).text()).toBe(index);
		expect((await readdir(root)).sort()).toEqual(["MEMORY.md", "topic.md"]);
	}
}));

test("aborting a deferred organizer settles local waiting and blocks its late plan", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-abort-"));
	const started = barrier("organizer started"), release = barrier("late organizer response"), ended = barrier("raw organizer ended");
	let signal: AbortSignal | undefined;
	const adapter = nativeAdapter(model, async function* (request) {
		if (!isMemoryOrganizerRequest(request)) { yield* nativeReply({ text: "Task complete" }); return; }
		signal = request.request?.signal ?? undefined; started.release();
		try { await release.wait(); yield* nativeReply({ text: validPlan }); } finally { ended.release(); }
	});
	const agent = await createAgent({ cwd: root, model, adapter, systemPrompt: "BASE", memory: { store: new LongTermMemory({ project: root }) } });
	try {
		const turn = agent.runTurn("Remember this note");
		const events: SessionEvent[] = [];
		const consume = (async () => { for await (const event of turn) events.push(event); })();
		await started.wait(); agent.abort();
		try {
			expect(signal?.aborted).toBe(true);
			await bounded(consume, "cancelled organizer settlement", 300);
			expect(await turn.result).toEqual({ status: "aborted" });
			expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1 });
		} finally { release.release(); await ended.wait(); await consume; }
		expect(await readdir(root)).toEqual([]);
	} finally { release.release(); await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

for (const action of ["timeout", "dispose"] as const) test(`${action} bounds uncooperative organizer waiting without late writes`, async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-bound-"));
	const started = barrier("organizer started"), release = barrier("late plan"), ended = barrier("late stream ended");
	let signal: AbortSignal | undefined;
	const adapter = nativeAdapter(model, async function* (request) {
		if (!isMemoryOrganizerRequest(request)) { yield* nativeReply({ text: "Completed answer" }); return; }
		signal = request.request?.signal ?? undefined; started.release();
		try { await release.wait(); yield* nativeReply({ text: validPlan }); } finally { ended.release(); }
	});
	const agent = await createAgent({ cwd: root, model, adapter, systemPrompt: "BASE", memory: { store: new LongTermMemory({ project: root }), organizerTimeoutMs: action === "timeout" ? 30 : 60_000 } });
	try {
		const turn = agent.runTurn("Remember this note");
		const events: SessionEvent[] = [];
		const consume = (async () => { for await (const event of turn) events.push(event); })();
		await started.wait();
		if (action === "dispose") await bounded(agent.dispose(), "dispose waiting for organizer", 500);
		await bounded(consume, "organizer deadline", 500);
		expect(signal?.aborted).toBe(true);
		expect(await turn.result).toEqual({ status: action === "timeout" ? "success" : "aborted" });
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, receipts: [{ ok: false, error: expect.any(String) }] });
		const result = await turn.result;
		release.release(); await ended.wait(); await agent.dispose(); await agent.dispose();
		expect(await turn.result).toEqual(result);
		expect(await readdir(root)).toEqual([]);
	} finally { release.release(); await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("organizer rejects an expired response before writing when microtasks delay its timer", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-expired-response-"));
	let returnedWithoutCancellation = false;
	const adapter = nativeAdapter(model, async function* (request) {
		if (!isMemoryOrganizerRequest(request)) { yield* nativeReply({ text: "Task complete" }); return; }
		const started = performance.now();
		// Keep timers queued while the model work exhausts its deadline.
		while (performance.now() - started < 30) await Promise.resolve();
		returnedWithoutCancellation = request.request?.signal?.aborted === false;
		yield* nativeReply({ text: validPlan });
	});
	const agent = await createAgent({ cwd: root, model, adapter, systemPrompt: "BASE", memory: { store: new LongTermMemory({ project: root }), organizerTimeoutMs: 5 } });
	try {
		const turn = agent.runTurn("Remember this note"), events: SessionEvent[] = [];
		for await (const event of turn) events.push(event);
		expect(await turn.result).toEqual({ status: "success" });
		expect(returnedWithoutCancellation).toBe(true);
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, receipts: [{ ok: false, error: expect.stringContaining("timed out after 5 ms") }] });
		expect(await readdir(root)).toEqual([]);
	} finally { await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("organizer timeout configuration rejects infinite, zero, fractional and coerced values", async () => {
	for (const organizerTimeoutMs of [0, -1, Infinity, NaN, 1.5, "60"]) {
		await expect(createAgent({ cwd: "/tmp", model, adapter: nativeAdapter(model, () => nativeReply({ text: "unused" })), systemPrompt: "BASE", memory: { store: new LongTermMemory({ project: "/tmp" }), organizerTimeoutMs: organizerTimeoutMs as number } })).rejects.toThrow("organizerTimeoutMs");
	}
});

for (const organizerTimeoutMs of [2_147_483_648, Number.MAX_SAFE_INTEGER]) test(`organizer deadline ${organizerTimeoutMs} remains pending through a short control deadline`, async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-long-deadline-"));
	const release = barrier("release organizer responses"), longStarted = barrier("long organizer started"), shortStarted = barrier("control organizer started");
	const longEnded = barrier("long organizer ended"), shortEnded = barrier("control organizer ended");
	let longSignal: AbortSignal | undefined;
	const adapter = (started: ReturnType<typeof barrier>, ended: ReturnType<typeof barrier>, capture?: (signal: AbortSignal | undefined) => void) => nativeAdapter(model, async function* (request) {
		if (!isMemoryOrganizerRequest(request)) { yield* nativeReply({ text: "Task complete" }); return; }
		capture?.(request.request?.signal ?? undefined); started.release();
		try { await release.wait(); yield* nativeReply({ text: validPlan }); } finally { ended.release(); }
	});
	const agents: Agent[] = [], consumers: Promise<void>[] = [], events: SessionEvent[] = [];
	try {
		const long = await createAgent({ cwd: root, model, systemPrompt: "BASE", adapter: adapter(longStarted, longEnded, signal => { longSignal = signal; }), memory: { store: new LongTermMemory({ project: join(root, "long") }), organizerTimeoutMs } });
		agents.push(long);
		const control = await createAgent({ cwd: root, model, systemPrompt: "BASE", adapter: adapter(shortStarted, shortEnded), memory: { store: new LongTermMemory({ project: join(root, "control") }), organizerTimeoutMs: 30 } });
		agents.push(control);
		const longTurn = long.runTurn("Remember this note"), controlTurn = control.runTurn("Remember this note");
		const consumingLong = (async () => { for await (const event of longTurn) events.push(event); })();
		const consumingControl = (async () => { for await (const _event of controlTurn) {} })();
		consumers.push(consumingLong, consumingControl);
		await longStarted.wait(); await shortStarted.wait();
		await bounded(consumingControl, "short organizer deadline", 500);
		expect(await controlTurn.result).toEqual({ status: "success" });
		expect(longSignal?.aborted).toBe(false);
		expect(events.some(event => event.type === "memory" && event.phase === "save")).toBe(false);
		release.release();
		await bounded(consumingLong, "long organizer save", 500);
		expect(await longTurn.result).toEqual({ status: "success" });
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "saved", calls: 1 });
		expect(await Bun.file(join(root, "long", "topic.md")).text()).toContain("Durable note");
	} finally {
		release.release(); await Promise.allSettled(consumers);
		await Promise.all(agents.map(agent => agent.dispose()));
		await Promise.all([longEnded.wait(), shortEnded.wait()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("cancellation during plan preflight prevents every later automatic file operation", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-preflight-cancel-"));
	const store = new LongTermMemory({ project: root }), validate = store.validateWrite.bind(store);
	let agent!: Agent;
	store.validateWrite = (input, source) => { validate(input, source); agent.abort(); };
	const adapter = nativeAdapter(model, request => nativeReply({ text: isMemoryOrganizerRequest(request) ? validPlan : "Task complete" }));
	agent = await createAgent({ cwd: root, model, adapter, systemPrompt: "BASE", memory: { store } });
	try {
		const turn = agent.runTurn("Remember a durable preference"), events: SessionEvent[] = [];
		for await (const event of turn) events.push(event);
		expect(await turn.result).toEqual({ status: "aborted" });
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1 });
		expect(await readdir(root)).toEqual([]);
	} finally { await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

async function exerciseOrganizer(stream: NativeStream, inspect: (root: string, events: SessionEvent[], calls: number) => Promise<void>, selectedModel: Model = model): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-protocol-"));
	let calls = 0;
	const adapter = nativeAdapter(selectedModel, async function* (request) {
		if (isMemoryOrganizerRequest(request)) {
			calls++;
			yield* stream(request);
		} else yield* nativeReply({ text: "Task complete" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model: selectedModel, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Remember the durable note.");
			const events: SessionEvent[] = [];
			for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			await inspect(root, events, calls);
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
}

const noWrite = async (root: string, events: SessionEvent[], calls: number) => {
	expect(calls).toBe(1);
	expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, receipts: [{ ok: false, error: expect.any(String) }] });
	expect(await readdir(root)).toEqual([]);
};

test("incomplete, late-failed, truncated, canceled and tool-proposing organizer streams cannot write memory", async () => {
	const streams: Record<string, NativeStream> = {
		"missing terminal": async function* () { for await (const chunk of nativeReply({ text: validPlan })) if (chunk.type !== EventType.RUN_FINISHED) yield chunk; },
		"late adapter failure": async function* () { yield* nativeReply({ text: validPlan }); throw new Error("late transport failure"); },
		"late RUN_ERROR": async function* () { yield* nativeReply({ text: validPlan }); yield { type: EventType.RUN_ERROR, code: "503", message: "late provider error" }; },
		"length terminal": () => nativeReply({ text: validPlan, finishReason: "length" }),
		"deferred terminal": () => nativeReply({ text: validPlan, metadata: { forge: { stopReason: "deferred" } } }),
		"canceled request": () => nativeReply({ text: validPlan, error: { code: "aborted", message: "organizer canceled" } }),
		"tool proposal": () => nativeReply({ text: validPlan, toolCalls: [{ id: "call", name: "write_memory", arguments: { path: "topic.md" } }] }),
		"empty text": () => nativeReply({ text: "" }),
	};
	for (const [name, stream] of Object.entries(streams)) {
		try { await exerciseOrganizer(stream, noWrite); }
		catch (error) { throw new Error(`${name}: ${String(error)}`); }
	}
});

test("failed organizer plans retain reported usage without writing memory", async () => {
	await exerciseOrganizer(() => nativeReply({ text: "not JSON", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } }), async (root, events, calls) => {
		expect(calls).toBe(1);
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
		expect(await readdir(root)).toEqual([]);
	});
});

test("organizer rejects trailing JSON, missing content, unknown keys and unauthorized scopes", async () => {
	const plans = [
		`${validPlan}\n{}`,
		JSON.stringify({ updates: [{ action: "write", scope: "project", path: "topic.md" }], indexes: [] }),
		JSON.stringify({ updates: [], indexes: [], extra: true }),
		JSON.stringify({ updates: [{ action: "write", scope: "global", path: "topic.md", content: "wrong scope" }], indexes: [] }),
		JSON.stringify({ updates: [{ action: "write", scope: "user", path: "topic.md", content: "wrong scope" }], indexes: [] }),
		JSON.stringify({ updates: [], indexes: [{ scope: "project", content: "index", extra: true }] }),
		JSON.stringify({ updates: [
			{ action: "write", scope: "project", path: "topic.md", content: "Should not persist" },
			{ action: "write", scope: "project", path: "MEMORY.md", content: "Wrong operation" },
		], indexes: [] }),
		JSON.stringify({ updates: [
			{ action: "write", scope: "project", path: "topic.md", content: "Should not persist" },
			{ action: "write", scope: "project", path: "large.md", content: "x".repeat(256 * 1024) },
		], indexes: [] }),
	];
	for (const plan of plans) await exerciseOrganizer(() => nativeReply({ text: plan }), noWrite);
});

function bedrockStream(complete: boolean): NativeStream {
	return async function* () {
		const events = (async function* (): AsyncGenerator<ConverseStreamOutput> {
			yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: validPlan } } };
			yield { contentBlockStop: { contentBlockIndex: 0 } };
			if (complete) yield { messageStop: { stopReason: "end_turn" } };
		})();
		let id = 0;
		yield* processConverseStream(events, () => `bedrock_${++id}`);
	};
}

test("Bedrock JSON without messageStop does not persist but the complete Converse response does", async () => {
	const bedrock = getCatalogModel("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0")!;
	await exerciseOrganizer(bedrockStream(false), noWrite, bedrock);
	await exerciseOrganizer(bedrockStream(true), async (root, events, calls) => {
		expect(calls).toBe(1);
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "saved", calls: 1 });
		expect(await readdir(root)).toEqual(["topic.md"]);
	}, bedrock);
});
