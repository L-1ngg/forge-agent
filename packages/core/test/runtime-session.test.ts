import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage } from "@forge-agent/core/sdk";
import { sessionMessages } from "../src/session-storage.ts";
import type { SessionEvent } from "@forge-agent/protocol";

const settings = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", systemPrompt: "session", cwd: process.cwd() };
function answer(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_session", type: "message", role: "assistant", model: settings.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "saved answer" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function collect(events: AsyncIterable<SessionEvent>) { const result: SessionEvent[] = []; for await (const event of events) result.push(event); return result; }

test("SDK session saves and reopens text; continuation adds no duplicate user", async () => {
	const requests: unknown[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json()); return answer(); } });
	const storage = new MemorySessionStorage();
	const options = { ...settings, baseUrl: server.url.toString(), storage };
	const agent = await createAgent(options);
	try {
		const turn = agent.runTurn("hello");
		const events = await collect(turn);
		expect(await turn.result).toEqual({ status: "success" });
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(sessionMessages(await storage.load()).map(message => message.role)).toEqual(["user", "assistant"]);
		expect(agent.getUsage()?.inputTokens).toBe(10);
		await agent.waitForIdle();
		await agent.dispose();
		const reopened = await createAgent(options);
		try {
			await collect(reopened.runTurn("next"));
			expect(JSON.stringify(requests[1])).toContain("saved answer");
		} finally { await reopened.dispose(); }
		// Reopen an interrupted transcript ending with a user: continue must not append it again.
		const pending = new MemorySessionStorage([{ role: "user", content: [{ type: "text", text: "pending" }], timestamp: 1 }]);
		const resumed = await createAgent({ ...options, storage: pending });
		try { await collect(resumed.continue()); expect(sessionMessages(await pending.load()).map(message => message.role)).toEqual(["user", "assistant"]); }
		finally { await resumed.dispose(); }
	} finally { await agent.dispose(); server.stop(true); }
});

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
for (const fail of [false, true]) test(`SDK session waits for storage before model and disposal; fault=${fail}`, async () => {
	let requests = 0;
	let writes = 0;
	const saving = gate(); const release = gate();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return answer(); } });
	const store = new MemorySessionStorage();
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), storage: {
			load: () => store.load(),
			async append(entry) { writes++; saving.resolve(); await release.promise; if (fail) throw new Error("disk failed"); await store.append(entry); },
		}
	});
	const turn = agent.runTurn("pending save");
	const running = collect(turn).then(() => undefined, error => error as Error);
	try {
		await saving.promise;
		expect(requests).toBe(0);
		let disposed = false;
		const disposing = agent.dispose().then(() => { disposed = true; return undefined; }, (error: Error) => { disposed = true; return error; });
		await Promise.resolve(); expect(disposed).toBe(false);
		release.resolve();
		const disposalError = await disposing;
		const error = await running;
		expect(requests).toBe(0);
		if (fail) { expect((error ?? disposalError)?.message).toBe("disk failed"); expect(writes).toBe(1); expect(await turn.result).toEqual({ status: "error" }); }
	} finally { release.resolve(); await running; await agent.dispose().catch(() => { }); server.stop(true); }
});

test("SDK session reports model failure separately from idle and remains reusable", async () => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return requests === 1 ? new Response(JSON.stringify({ error: { message: "invalid request" } }), { status: 400 }) : answer(); } });
	const agent = await createAgent({ ...settings, baseUrl: server.url.toString() });
	try {
		const failed = agent.runTurn("bad"); await collect(failed);
		expect(await failed.result).toEqual({ status: "error" });
		await agent.waitForIdle();
		const next = agent.runTurn("good"); await collect(next);
		expect(await next.result).toEqual({ status: "success" });
	} finally { await agent.dispose(); server.stop(true); }
});

test("SDK session fault disables reuse without additional persistence", async () => {
	let writes = 0;
	const agent = await createAgent({ ...settings, storage: { load: async () => ({ entries: [], leafId: null }), append: async () => { writes++; throw new Error("store unavailable"); } } });
	try {
		await expect(collect(agent.runTurn("first"))).rejects.toThrow("store unavailable");
		expect(() => agent.runTurn("again")).toThrow("faulted");
		expect(writes).toBe(1);
	} finally { await agent.dispose(); }
});

test("SDK tool batches finish serial preparation before parallel effects and persist in call order", async () => {
	const trace: string[] = [];
	let calls = 0;
	const secondDone = gate();
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			const body = await request.json(); trace.push(`model:${++calls}`);
			if (calls > 1) { expect(JSON.stringify(body)).toContain("final-b"); return answer(); }
			const events = [
				{ type: "message_start", message: { id: "msg_tools", type: "message", role: "assistant", model: settings.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
				...["a", "b"].flatMap((id, index) => [
					{ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "work", input: {} } },
					{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ id }) } },
					{ type: "content_block_stop", index },
				]),
				{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
				{ type: "message_stop" },
			];
			return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		}
	});
	const storage = new MemorySessionStorage();
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(),
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		storage: { load: () => storage.load(), async append(entry) { if (entry.type === "message") trace.push(`save:${entry.message.toolCallId ?? entry.message.role}`); await storage.append(entry); } },
		toolInputRewrites: { work: async input => { const value = input as { id: string }; trace.push(`rewrite:${value.id}`); return { id: `final-${value.id}` }; } },
		tools: [{
			name: "work", label: "Work", description: "record", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
			async execute(input) { const { id } = input as { id: string }; trace.push(`execute:${id}`); if (id === "final-a") await secondDone.promise; else secondDone.resolve(); return { content: [{ type: "text", text: id }], details: id }; },
		}],
	});
	try {
		await collect(agent.runTurn("work"));
		expect(trace).toEqual(["save:user", "model:1", "save:assistant", "rewrite:a", "rewrite:b", "execute:final-a", "execute:final-b", "save:a", "save:b", "model:2", "save:assistant"]);
	} finally { secondDone.resolve(); await agent.dispose(); server.stop(true); }
});

test("SDK session binds steering receipts to one invocation and returns pending input on abort", async () => {
	const first = gate(); const release = gate(); const second = gate();
	let requests = 0;
	const bodies: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			bodies.push(await request.json()); requests++;
			if (requests === 1) { first.resolve(); await release.promise; }
			if (requests === 2) { second.resolve(); return new Response(new ReadableStream({ start() { } }), { headers: { "content-type": "text/event-stream" } }); }
			return answer();
		}
	});
	const agent = await createAgent({ ...settings, baseUrl: server.url.toString() });
	const turn = agent.runTurn("first"); const running = collect(turn);
	try {
		await first.promise;
		const steering = agent.steer("steer", turn.id); const pending = agent.followUp("pending", turn.id);
		expect(steering.accepted).toBe(true); expect(pending.accepted).toBe(true);
		release.resolve(); await second.promise; agent.abort(); await running;
		if (!steering.accepted || !pending.accepted) throw new Error("Missing receipts");
		expect(await steering.processed).toBe(true); expect(await pending.processed).toBe(false);
		const next = agent.runTurn("next");
		const iterator = next[Symbol.asyncIterator]();
		expect(agent.steer("stale", turn.id)).toEqual({ accepted: false });
		while (!(await iterator.next()).done) { }
		expect(JSON.stringify(bodies[2])).not.toContain("pending");
		expect(JSON.stringify(bodies[2])).toContain("steer");
	} finally { release.resolve(); agent.abort(); await running; await agent.dispose(); server.stop(true); }
});

test("SDK session unstarted cancellation performs zero model calls and writes", async () => {
	let requests = 0; let writes = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return answer(); } });
	const agent = await createAgent({ ...settings, baseUrl: server.url.toString(), storage: { load: async () => ({ entries: [], leafId: null }), append: async () => { writes++; } } });
	try {
		const turn = agent.runTurn("unused"); const iterator = turn[Symbol.asyncIterator](); agent.abort();
		expect((await iterator.next()).done).toBe(true); expect([requests, writes]).toEqual([0, 0]); expect(await turn.result).toEqual({ status: "aborted" });
		await collect(agent.runTurn("fresh")); expect([requests, writes]).toEqual([1, 2]);
	} finally { await agent.dispose(); server.stop(true); }
});

for (const mode of ["all", "one-at-a-time"] as const) test(`SDK exposes ${mode} steering and follow-up consumption`, async () => {
 const started = gate(); const release = gate(); const requests: unknown[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  requests.push(await request.json()); if (requests.length === 1) { started.resolve(); await release.promise; } return answer();
 } });
 const agent = await createAgent({ ...settings, baseUrl: server.url.toString(), steeringMode: mode, followUpMode: mode });
 const turn = agent.runTurn("initial"); const running = collect(turn);
 try {
  await started.promise;
  const receipts = [agent.steer("steer-one", turn.id), agent.steer("steer-two", turn.id), agent.followUp("follow-one", turn.id), agent.followUp("follow-two", turn.id)];
  release.resolve(); await running;
  expect(requests).toHaveLength(mode === "all" ? 3 : 5);
  expect(JSON.stringify(requests[1])).toContain("steer-one");
  if (mode === "all") expect(JSON.stringify(requests[1])).toContain("steer-two");
  else expect(JSON.stringify(requests[1])).not.toContain("steer-two");
  expect(JSON.stringify(requests[mode === "all" ? 2 : 3])).toContain("follow-one");
  for (const receipt of receipts) { expect(receipt.accepted).toBe(true); if (receipt.accepted) expect(await receipt.processed).toBe(true); }
 } finally { release.resolve(); await running; await agent.dispose(); server.stop(true); }
});

test("SDK compact settles result and idle when the interrupted write fails", async () => {
 const saving = gate(); const release = gate();
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { throw new Error("Model must not start"); } });
 const agent = await createAgent({ ...settings, baseUrl: server.url.toString(), storage: {
  load: async () => ({ entries: [], leafId: null }), async append() { saving.resolve(); await release.promise; throw new Error("disk failed"); },
 } });
 const turn = agent.runTurn("pending write"); const iterator = turn[Symbol.asyncIterator]();
 try {
  await iterator.next(); await saving.promise;
  const idle = agent.waitForIdle(); const compact = agent.compact().catch(error => error as Error);
  release.resolve(); expect((await compact as Error).message).toBe("disk failed");
  expect(await Promise.race([turn.result, Bun.sleep(100).then(() => "pending")])).toEqual({ status: "error" });
  expect(await Promise.race([idle.then(() => "idle"), Bun.sleep(100).then(() => "pending")])).toBe("idle");
  expect(() => agent.runTurn("reuse")).toThrow("faulted");
 } finally { release.resolve(); await agent.dispose(); server.stop(true); }
});
