import { expect, test } from "bun:test";
import fc from "fast-check";
import type { SessionEvent, SessionMessage } from "@myh/protocol";
import { createAgent } from "../src/agent.ts";
import { ExecutionCore, type ExecutionDriver } from "../src/execution-core.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const answer: SessionMessage = { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1, stopReason: "stop" };
async function consume(events: AsyncIterable<SessionEvent>) { for await (const event of events) void event; }
function fixture(stream: ExecutionDriver["stream"] = async () => answer) {
	let executions = 0;
	const core = new ExecutionCore({ contextWindow: 1000, stream, async execute() { executions++; throw new Error("unexpected tool"); }, abortInteractions() {} });
	return { core, executions: () => executions };
}
const options = { provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd() };

test("ADR010: abort an acquired but unstarted iterator without model, tools or commit; reuse", async () => {
	let models = 0;
	let commits = 0;
	const { core, executions } = fixture(async () => { models++; return answer; });
	const agent = await createAgent({ ...options, storage: { load: async () => [], appendTurn: async () => { commits++; } } }, () => core);
	try {
		const iterator = agent.runTurn("canceled")[Symbol.asyncIterator]();
		agent.abort();
		expect((await iterator.next()).done).toBe(true);
		expect([models, executions(), commits]).toEqual([0, 0, 0]);
		await consume(agent.runTurn("fresh"));
		expect([models, commits]).toEqual([1, 1]);
	} finally { await agent.dispose(); }
});

test("ADR010: saving rejects intervention, abort cannot leak it into the next invocation", async () => {
	const saving = gate();
	const release = gate();
	const contexts: string[][] = [];
	const { core } = fixture(async (messages) => {
		contexts.push(messages.filter((message) => message.role === "user").flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])));
		return answer;
	});
	let commits = 0;
	const agent = await createAgent({ ...options, storage: { load: async () => [], async appendTurn() { commits++; saving.resolve(); await release.promise; } } }, () => core);
	const turn = agent.runTurn("first");
	const running = consume(turn);
	try {
		await saving.promise;
		expect(agent.steer("late-steer", turn.id)).toEqual({ accepted: false });
		expect(agent.followUp("late-follow", turn.id)).toEqual({ accepted: false });
		agent.abort();
		release.resolve();
		await running;
		await consume(agent.runTurn("second"));
		expect(contexts).toEqual([["first"], ["first", "second"]]);
		expect(commits).toBe(2);
	} finally { release.resolve(); await running; await agent.dispose(); }
});

test("ADR010: receipt confirms processed input; cancellation returns only pending input", async () => {
	const first = gate();
	const second = gate();
	const releaseFirst = gate();
	let models = 0;
	const { core } = fixture(async (_messages, signal) => {
		if (++models === 1) { first.resolve(); await releaseFirst.promise; }
		else { second.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); }
		return answer;
	});
	const running = consume(core.runTurn("initial"));
	await first.promise;
	const processed = core.steer("processed");
	const pending = core.followUp("pending");
	expect(processed?.accepted).toBe(true);
	expect(pending?.accepted).toBe(true);
	releaseFirst.resolve();
	await second.promise;
	core.abort();
	await running;
	if (!processed?.accepted || !pending?.accepted) throw new Error("missing receipts");
	expect(await processed.processed).toBe(true);
	expect(await pending.processed).toBe(false);
	expect(core.steer("idle")).toEqual({ accepted: false });
});

test("ADR010: core closes acceptance before buffered terminal events are consumed", async () => {
	const { core } = fixture();
	const iterator = core.runTurn("initial")[Symbol.asyncIterator]();
	await iterator.next();
	await Bun.sleep(0);
	try {
		expect(core.steer("late")).toEqual({ accepted: false });
		expect(core.followUp("late")).toEqual({ accepted: false });
	} finally { await iterator.return?.(); }
});

test("ADR010: stale SDK invocation id cannot reach a newer execution", async () => {
	const started = gate();
	const release = gate();
	let models = 0;
	const { core } = fixture(async () => { if (++models === 2) { started.resolve(); await release.promise; } return answer; });
	const agent = await createAgent(options, () => core);
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
	const { core } = fixture();
	const agent = await createAgent({ ...options, storage: { load: async () => [], async appendTurn() {
		saving.resolve(); await release.promise; if (fail) throw new Error("disk failed"); committed = true;
	} } }, () => core);
	const outcome = consume(agent.runTurn("first")).then(() => undefined, (error: Error) => error);
	await saving.promise;
	let disposed = false;
	const disposing = agent.dispose().then(() => { disposed = true; });
	expect(agent.dispose()).toBe(agent.dispose());
	await Bun.sleep(0);
	expect(disposed).toBe(false);
	release.resolve();
	await disposing;
	expect(committed).toBe(!fail);
	const result = await outcome;
	if (fail) expect(result?.message).toBe("disk failed");
	else expect(result).toBeUndefined();
});

test("ADR010: abort at agent_end before commit keeps storage untouched", async () => {
	let commits = 0;
	const { core } = fixture();
	const agent = await createAgent({ ...options, storage: { load: async () => [], appendTurn: async () => { commits++; } } }, () => core);
	try {
		for await (const event of agent.runTurn("initial")) if (event.type === "agent_end") agent.abort();
		expect(commits).toBe(0);
	} finally { await agent.dispose(); }
});

for (const stopReason of ["deferred", "error"] as const) test(`ADR010: ${stopReason} returns unprocessed receipts without leaking input`, async () => {
	const started = gate();
	const release = gate();
	const contexts: SessionMessage[][] = [];
	const { core } = fixture(async (messages) => {
		contexts.push(structuredClone([...messages]));
		started.resolve(); await release.promise;
		return { ...answer, stopReason };
	});
	const running = consume(core.runTurn("first"));
	await started.promise;
	const receipt = core.followUp("unprocessed");
	release.resolve();
	await running;
	if (!receipt.accepted) throw new Error("missing receipt");
	expect(await receipt.processed).toBe(false);
	await consume(core.runTurn("next"));
	expect(JSON.stringify(contexts)).not.toContain("unprocessed");
});

test("ADR010: generated input/end/cancel interleavings process each accepted input once or return it", async () => {
	await fc.assert(fc.asyncProperty(
		fc.array(fc.record({ ticks: fc.integer({ min: 0, max: 6 }), followup: fc.boolean(), cancel: fc.boolean() }), { minLength: 1, maxLength: 15 }),
		async (actions) => {
			const seen: string[] = [];
			const { core } = fixture(async (messages) => {
				const text = messages.filter((message) => message.role === "user").at(-1)?.content[0];
				if (text?.type === "text") seen.push(text.text);
				await Promise.resolve();
				return answer;
			});
			const running = consume(core.runTurn("root"));
			const receipts = [];
			for (const [index, action] of actions.entries()) {
				for (let tick = 0; tick < action.ticks; tick++) await Promise.resolve();
				const text = `input-${index}`;
				const receipt = action.followup ? core.followUp(text) : core.steer(text);
				receipts.push({ text, receipt });
				if (action.cancel) core.abort();
			}
			await running;
			for (const { text, receipt } of receipts) {
				const processed = receipt.accepted && await receipt.processed;
				expect(seen.filter((input) => input === text)).toHaveLength(processed ? 1 : 0);
			}
			const count = seen.length;
			await consume(core.runTurn("fresh"));
			expect(seen.slice(count)).toEqual(["fresh"]);
		},
	), { seed: 91004, numRuns: 40 });
});
