import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { scriptedModel, type ScriptedModel } from "../../../tests/fixtures/scripted-model.ts";
import { propertyOptions } from "../../../tests/support/property.ts";
import { createAgent } from "../src/agent.ts";
import { MemorySessionStorage, sessionMessages } from "../src/session-storage.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const answer: SessionMessage = { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1, stopReason: "stop" };
async function consume(events: AsyncIterable<SessionEvent>) { for await (const event of events) void event; }
function fixture(stream: ScriptedModel["stream"] = async () => answer) {
	const modelOptions = { ...scriptedModel({ contextWindow: 100000, stream }) };
	return { modelOptions };
}
const options = { provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd() };

test("ADR010: abort an acquired but unstarted iterator without model, tools or commit; reuse", async () => {
	let models = 0;
	let commits = 0;
	const { modelOptions } = fixture(async () => { models++; return answer; });
	const agent = await createAgent({ ...options, storage: { load: async () => ({ entries: [], leafId: null }), append: async () => { commits++; } }, ...modelOptions });
	try {
		const iterator = agent.runTurn("canceled")[Symbol.asyncIterator]();
		agent.abort();
		expect((await iterator.next()).done).toBe(true);
		expect([models, commits]).toEqual([0, 0]);
		await consume(agent.runTurn("fresh"));
		expect([models, commits]).toEqual([1, 2]);
	} finally { await agent.dispose(); }
});

test("ADR010: saving rejects intervention, abort cannot leak it into the next invocation", async () => {
	const saving = gate();
	const release = gate();
	const contexts: string[][] = [];
	const { modelOptions } = fixture(async (messages) => {
		contexts.push(messages.filter((message) => message.role === "user").flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])));
		return answer;
	});
	let commits = 0;
	const agent = await createAgent({ ...options, storage: { load: async () => ({ entries: [], leafId: null }), async append(entry) { commits++; if (entry.type === "message" && entry.message.role === "assistant") { saving.resolve(); await release.promise; } } }, ...modelOptions });
	const turn = agent.runTurn("first");
	const running = consume(turn);
	try {
		await saving.promise;
		const lateSteer = agent.steer("late-steer", turn.id);
		const lateFollow = agent.followUp("late-follow", turn.id);
		agent.abort();
		release.resolve();
		await running;
		await consume(agent.runTurn("second"));
		expect(contexts).toEqual([["first"], ["first", "second"]]);
		expect(commits).toBe(4);
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("ADR010: receipt confirms processed input; cancellation returns only pending input", async () => {
	const first = gate();
	const second = gate();
	const releaseFirst = gate();
	let models = 0;
	const { modelOptions } = fixture(async (_messages, signal) => {
		if (++models === 1) { first.resolve(); await releaseFirst.promise; }
		else { second.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); }
		return answer;
	});
	const agent = await createAgent({ ...options, ...modelOptions });
	const turn = agent.runTurn("initial");
	const running = consume(turn);
	await first.promise;
	const processed = agent.steer("processed", turn.id);
	const pending = agent.followUp("pending", turn.id);
	expect(processed?.accepted).toBe(true);
	expect(pending?.accepted).toBe(true);
	releaseFirst.resolve();
	await second.promise;
	agent.abort();
	await running;
	if (!processed?.accepted || !pending?.accepted) throw new Error("missing receipts");
	expect(await processed.processed).toBe(true);
	expect(await pending.processed).toBe(false);
	expect(agent.steer("idle", turn.id)).toEqual({ accepted: false });
	await agent.dispose();
});

test("ADR010: SDK closes acceptance before buffered terminal events are consumed", async () => {
	const { modelOptions } = fixture();
	const agent = await createAgent({ ...options, ...modelOptions });
	const turn = agent.runTurn("initial");
	const iterator = turn[Symbol.asyncIterator]();
	await iterator.next();
	await Bun.sleep(0);
	try {
		expect(agent.steer("late", turn.id)).toEqual({ accepted: false });
		expect(agent.followUp("late", turn.id)).toEqual({ accepted: false });
	} finally { await iterator.return?.(); await agent.dispose(); }
});

test("ADR010: stale SDK invocation id cannot reach a newer execution", async () => {
	const started = gate();
	const release = gate();
	let models = 0;
	const { modelOptions } = fixture(async () => { if (++models === 2) { started.resolve(); await release.promise; } return answer; });
	const agent = await createAgent({ ...options, ...modelOptions });
	const old = agent.runTurn("old");
	await consume(old);
	const current = agent.runTurn("current");
	const running = consume(current);
	try {
		await started.promise;
		expect(agent.steer("stale", old.id)).toEqual({ accepted: false });
		expect(agent.followUp("stale", old.id)).toEqual({ accepted: false });
		const receipt = agent.steer("fresh", current.id);
		expect(receipt?.accepted).toBe(true);
		release.resolve();
		await running;
		if (!receipt?.accepted) throw new Error("missing receipt");
		expect(await receipt.processed).toBe(true);
		expect(models).toBe(3);
	} finally { release.resolve(); await running; await agent.dispose(); }
});

for (const fail of [false, true]) test(`ADR010: dispose waits for an already started commit (failure=${fail})`, async () => {
	const saving = gate();
	const release = gate();
	let committed = false;
	const { modelOptions } = fixture();
	const agent = await createAgent({ ...options, storage: { load: async () => ({ entries: [], leafId: null }), async append() {
		saving.resolve(); await release.promise; if (fail) throw new Error("disk failed"); committed = true;
	} }, ...modelOptions });
	const outcome = consume(agent.runTurn("first")).then(() => undefined, (error: Error) => error);
	await saving.promise;
	let disposed = false;
	const disposing = agent.dispose().then(() => { disposed = true; return undefined; }, (error: Error) => { disposed = true; return error; });
	expect(agent.dispose()).toBe(agent.dispose());
	await Bun.sleep(0);
	expect(disposed).toBe(false);
	release.resolve();
	const disposalError = await disposing;
	if (fail && disposalError) expect(disposalError.message).toBe("disk failed");
	expect(committed).toBe(!fail);
	const result = await outcome;
	if (fail) expect((result ?? disposalError)?.message).toBe("disk failed");
	else expect(result).toBeUndefined();
});

test("incremental: abort at agent_end retains saved history", async () => {
	let commits = 0;
	const { modelOptions } = fixture();
	const agent = await createAgent({ ...options, storage: { load: async () => ({ entries: [], leafId: null }), append: async () => { commits++; } }, ...modelOptions });
	try {
		for await (const event of agent.runTurn("initial")) if (event.type === "agent_end") agent.abort();
		expect(commits).toBe(2);
	} finally { await agent.dispose(); }
});

for (const stopReason of ["deferred", "error"] as const) test(`ADR010: ${stopReason} returns unprocessed receipts without leaking input`, async () => {
	const started = gate();
	const release = gate();
	const contexts: SessionMessage[][] = [];
	const { modelOptions } = fixture(async (messages) => {
		contexts.push(structuredClone([...messages]));
		started.resolve(); await release.promise;
		return { ...answer, stopReason };
	});
	const agent = await createAgent({ ...options, ...modelOptions });
	const turn = agent.runTurn("first");
	const running = consume(turn);
	await started.promise;
	const receipt = agent.followUp("unprocessed", turn.id);
	release.resolve();
	await running;
	if (!receipt.accepted) throw new Error("missing receipt");
	expect(await receipt.processed).toBe(false);
	await consume(agent.runTurn("next"));
	await agent.dispose();
	expect(JSON.stringify(contexts)).not.toContain("unprocessed");
});

test("ADR010: generated input/end/cancel interleavings process each accepted input once or return it", async () => {
	await fc.assert(fc.asyncProperty(
		fc.array(fc.record({ ticks: fc.integer({ min: 0, max: 6 }), followup: fc.boolean(), cancel: fc.boolean() }), { minLength: 1, maxLength: 15 }),
		async (actions) => {
			const seen: string[] = [];
			const storage = new MemorySessionStorage();
			const { modelOptions } = fixture(async (messages) => {
				const text = messages.filter((message) => message.role === "user").at(-1)?.content[0];
				if (text?.type === "text") seen.push(text.text);
				await Promise.resolve();
				return answer;
			});
			const agent = await createAgent({ ...options, ...modelOptions, storage });
			const turn = agent.runTurn("root");
			const running = consume(turn);
			const receipts = [];
			for (const [index, action] of actions.entries()) {
				for (let tick = 0; tick < action.ticks; tick++) await Promise.resolve();
				const text = `input-${index}`;
				const receipt = action.followup ? agent.followUp(text, turn.id) : agent.steer(text, turn.id);
				receipts.push({ text, receipt });
				if (action.cancel) agent.abort();
			}
			await running;
			const saved = sessionMessages(await storage.load()).filter((message) => message.role === "user").flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []));
			for (const { text, receipt } of receipts) {
				const processed = receipt.accepted && await receipt.processed;
				expect(saved.filter((input) => input === text)).toHaveLength(processed ? 1 : 0);
				expect(seen.filter((input) => input === text).length).toBeLessThanOrEqual(processed ? 1 : 0);
			}
			const count = seen.length;
			await consume(agent.runTurn("fresh"));
			await agent.dispose();
			expect(seen.slice(count)).toEqual(["fresh"]);
		},
	), propertyOptions(91004, 40));
});
