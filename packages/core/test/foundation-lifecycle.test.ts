import { expect, test } from "bun:test";
import type { TurnResult } from "@forge-agent/protocol";
import { createAgent, MemorySessionStorage, type Model } from "../src/sdk.ts";
import { gate } from "../../../tests/fixtures/model-response.ts";
import { replyAdapter, type NativeReply } from "../../../tests/fixtures/native-reply.ts";

const model: Model = {
	id: "lifecycle-model", name: "Lifecycle model", api: "faux", provider: "fixture", baseUrl: "https://unused.invalid",
	reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const settings = { cwd: process.cwd(), systemPrompt: "", model, skills: false as const, context: { enabled: false }, retry: { enabled: false } };

test("waitForIdle waits for manual compaction that is replacing an acquired invocation", async () => {
	const summarizing = gate(), release = gate();
	const storage = new MemorySessionStorage([
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "Old goal" }] },
		{ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "Old investigation ".repeat(1000) }] },
		{ role: "user", timestamp: 3, content: [{ type: "text", text: "Current task" }] },
	]);
	const agent = await createAgent({ ...settings, storage, context: { enabled: false, keepRecentTokens: 1 }, adapter: replyAdapter(model, async () => {
		summarizing.resolve(); await release.promise;
		return { text: JSON.stringify({ states: [], claims: [], taskChanged: false }) };
	}) });
	const turn = agent.runTurn("Unused input");
	turn[Symbol.asyncIterator]();
	const compacting = agent.compact();
	let idle = false;
	const waiting = agent.waitForIdle().then(() => { idle = true; });
	try {
		await summarizing.promise;
		await Promise.resolve();
		expect(await turn.result).toEqual({ status: "aborted" });
		expect(idle).toBe(false);
		release.resolve();
		expect(await compacting).toMatchObject({ status: "complete" });
		await waiting;
		expect(idle).toBe(true);
		expect(JSON.stringify(await storage.load())).not.toContain("Unused input");
	} finally { release.resolve(); await compacting; await waiting; await agent.dispose(); }
});

const terminals: Array<{ name: string; response: NativeReply; result: TurnResult; policy?: boolean }> = [
	{ name: "success", response: { text: "Complete answer" }, result: { status: "success" } },
	{ name: "policy", response: { text: "Policy-completed answer" }, result: { status: "success", terminationReason: "policy" }, policy: true },
	{ name: "error", response: { error: { message: "Permanent provider error" } }, result: { status: "error" } },
	{ name: "length", response: { text: "Truncated answer", finishReason: "length" }, result: { status: "length" } },
	{ name: "deferred", response: { metadata: { forge: { stopReason: "deferred" } } }, result: { status: "deferred" } },
];

for (const close of ["break", "dispose"] as const) for (const terminal of terminals) test(`closing after agent_end preserves the completed ${terminal.name} result (${close})`, async () => {
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...settings, storage, adapter: replyAdapter(model, () => terminal.response), ...(terminal.policy ? { shouldStopAfterTurn: () => true } : {}) });
	const turn = agent.runTurn("Task");
	try {
		let ended = false;
		for await (const event of turn) if (event.type === "agent_end") {
			ended = true;
			expect(event).toMatchObject({ outcome: terminal.result.status, ...(terminal.result.terminationReason ? { terminationReason: terminal.result.terminationReason } : {}) });
			if (close === "dispose") await agent.dispose();
			break;
		}
		expect(ended).toBe(true);
		expect(await turn.result).toEqual(terminal.result);
		expect((await storage.load()).entries.map(entry => entry.type === "message" ? entry.message.role : entry.type)).toEqual(["user", "assistant"]);
	} finally { await agent.dispose(); }
});

test("an observer throwing at agent_end does not replace a committed result with cancellation", async () => {
	const agent = await createAgent({ ...settings, adapter: replyAdapter(model, () => ({ text: "Complete answer" })) });
	const turn = agent.runTurn("Task"), observerError = new Error("Host rendering failed");
	try {
		const observing = (async () => { for await (const event of turn) if (event.type === "agent_end") throw observerError; })();
		await expect(observing).rejects.toBe(observerError);
		expect(await turn.result).toEqual({ status: "success" });
	} finally { await agent.dispose(); }
});

test("closing an in-flight iterator still aborts and waits for adapter cleanup", async () => {
	const started = gate(), canceled = gate(), release = gate();
	let cleaned = false;
	const agent = await createAgent({ ...settings, adapter: replyAdapter(model, async request => {
		started.resolve();
		const signal = request.request?.signal;
		if (!signal) throw new Error("Missing cancellation signal");
		if (!signal.aborted) await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); });
		canceled.resolve(); await release.promise; cleaned = true;
		return { error: { code: "aborted", message: "Request aborted" } };
	}) });
	const turn = agent.runTurn("Task"), iterator = turn[Symbol.asyncIterator]();
	await iterator.next();
	await started.promise;
	let closed = false;
	const closing = iterator.return!().then(() => { closed = true; });
	try {
		await canceled.promise;
		expect(closed).toBe(false); expect(cleaned).toBe(false);
		release.resolve(); await closing;
		expect(cleaned).toBe(true);
		expect(await turn.result).toEqual({ status: "aborted" });
	} finally { release.resolve(); await closing; await agent.dispose(); }
});

for (const state of ["disposed", "faulted"] as const) test(`configureContext rejects a ${state} instance`, async () => {
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...settings, adapter: replyAdapter(model, () => ({ text: "Answer" })), storage: state === "faulted" ? {
		load: () => storage.load(), async append() { throw new Error("Storage unavailable"); },
	} : storage });
	try {
		if (state === "disposed") await agent.dispose();
		else await expect((async () => { for await (const _event of agent.runTurn("Task")) { } })()).rejects.toThrow("Storage unavailable");
		expect(() => agent.configureContext({ keepRecentTokens: 100 })).toThrow(state);
	} finally { await agent.dispose(); }
});
