import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { response, type SessionEvent } from "../../packages/protocol/src/index.ts";
import { AgentRunner, createPiTestPort, RequestBus, SessionStore, type AgentPort } from "../../packages/core/src/index.ts";
import type { HarnessTool } from "../../packages/tools/src/index.ts";

function tool(execute: HarnessTool<object, unknown>["execute"]): HarnessTool<object, unknown> {
	return {
		name: "capture",
		label: "Capture",
		description: "Capture a required string.",
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
		execute,
	};
}

async function collect(port: Pick<AgentPort, "runTurn">, input = "start"): Promise<SessionEvent[]> {
	const events: SessionEvent[] = [];
	for await (const event of port.runTurn(input)) events.push(event);
	return events;
}

function userTexts(events: SessionEvent[]): string[] {
	return events.flatMap((event) => event.type === "message_end" && event.message.role === "user"
		? event.message.content.flatMap((content) => content.type === "text" ? [content.text] : [])
		: []);
}

test("owned core fails every tool call in a length-limited message without preparing or executing it", async () => {
	let executions = 0;
	let rewrites = 0;
	const port = createPiTestPort({
		tools: [tool(async () => { executions++; return { ok: true, value: "unexpected" }; })],
		toolInputRewrites: { capture: (input) => { rewrites++; return input; } },
		responses: [
			{ toolCalls: ["first", "second"].map((id) => ({ id, name: "capture", arguments: { value: "valid but truncated" } })), stopReason: "length" },
			{ text: "recovered" },
		],
	});
	const events = await collect(port);
	expect(executions).toBe(0);
	expect(rewrites).toBe(0);
	for (const id of ["first", "second"]) {
		expect(events.filter((event) => event.type === "tool_execution_start" && event.toolCallId === id)).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === id)).toMatchObject([{ isError: true }]);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.toolCallId === id)).toMatchObject([{ message: { isError: true } }]);
	}
	expect(events.filter((event) => event.type === "turn_end")).toMatchObject([{ stopReason: "length" }, { stopReason: "stop" }]);
});

test("owned core settles unserializable results and waits for sibling tools before releasing the instance", async () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const values: Record<string, unknown> = {
		bigint: 1n,
		circular,
		toJSON: { toJSON() { throw new Error("injected serialization failure"); } },
	};
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let markFinished!: () => void;
	const finished = new Promise<void>((resolve) => { markFinished = resolve; });
	let slowDone = false;
	const port = createPiTestPort({
		tools: [tool(async (input) => {
			const value = (input as { value: string }).value;
			if (value !== "slow") return { ok: true, value: values[value] };
			await gate;
			slowDone = true;
			markFinished();
			return { ok: true, value: "completed" };
		})],
		responses: [
			{ toolCalls: ["bigint", "circular", "toJSON", "slow"].map((id) => ({ id, name: "capture", arguments: { value: id } })), stopReason: "tool_use" },
			{ text: "recovered" },
			{ text: "fresh" },
		],
	});
	const events: SessionEvent[] = [];
	let failures = 0;
	try {
		for await (const event of port.runTurn("start")) {
			events.push(event);
			if (event.type === "tool_execution_end" && event.isError && ++failures === 3) {
				expect(slowDone).toBe(false);
				await expect(collect(port, "overlap")).rejects.toThrow("already");
				release();
			}
			if (event.type === "agent_end") expect(slowDone).toBe(true);
		}
	} finally {
		release();
		await finished;
	}
	for (const id of ["bigint", "circular", "toJSON", "slow"]) {
		expect(events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === id)).toMatchObject([{ isError: id !== "slow" }]);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.toolCallId === id)).toHaveLength(1);
	}
	expect(events.filter((event) => event.type === "turn_end")).toMatchObject([{ stopReason: "tool_use" }, { stopReason: "stop" }]);
	expect(events.at(-1)?.type).toBe("agent_end");
	expect(userTexts(await collect(port, "fresh"))).toEqual(["fresh"]);
});

test.each([false, true])("owned core preserves batch termination semantics with mixed permissions: %s", async (mixed) => {
	const executed: string[] = [];
	const port = createPiTestPort({
		tools: [tool(async (input) => { executed.push((input as { value: string }).value); return { ok: true, value: "ok" }; })],
		permission: { rules: [
			{ tool: "capture", argsPattern: '{"value":"deny"}', effect: "deny", reason: "test deny" },
			{ tool: "capture", argsPattern: '{"value":"allow"}', effect: "allow" },
		] },
		responses: [
			{ toolCalls: ["deny", mixed ? "allow" : "deny"].map((value, index) => ({ id: `call-${index}`, name: "capture", arguments: { value } })), stopReason: "tool_use" },
			{ text: "summary" },
		],
	});
	const events = await collect(port);
	expect(executed).toEqual(mixed ? ["allow"] : []);
	expect(events.filter((event) => event.type === "message_end" && event.message.role === "toolResult")).toHaveLength(2);
	expect(events.filter((event) => event.type === "turn_end").map((event) => event.stopReason)).toEqual(mixed ? ["tool_use", "stop"] : ["tool_use"]);
});

test.each(["steer", "followUp"] as const)("owned core drains %s after an entirely denied batch without leaking it into the next invocation", async (queue) => {
	const port = createPiTestPort({
		tools: [tool(async () => { throw new Error("denied tool executed"); })],
		permission: { rules: [{ tool: "capture", argsPattern: "*", effect: "deny", reason: "test deny" }] },
		responses: [
			{ text: "requesting", toolCalls: [{ id: "denied", name: "capture", arguments: { value: "deny" } }], stopReason: "tool_use" },
			{ echoLastUser: true },
			{ echoLastUser: true },
			{ echoLastUser: true },
		],
	});
	const events: SessionEvent[] = [];
	let queued = false;
	for await (const event of port.runTurn("initial")) {
		events.push(event);
		if (event.type === "message_delta" && !queued) {
			queued = true;
			port[queue]("queued-first");
			port[queue]("queued-second");
		}
	}
	expect(queued).toBe(true);
	expect(userTexts(events)).toEqual(["initial", "queued-first", "queued-second"]);
	expect(events.filter((event) => event.type === "turn_end").map((event) => event.stopReason)).toEqual(["tool_use", "stop", "stop"]);
	expect(userTexts(await collect(port, "fresh"))).toEqual(["fresh"]);
});

test("owned core rejects unknown tools and invalid arguments without executing them", async () => {
	let executions = 0;
	const port = createPiTestPort({
		tools: [tool(async () => { executions++; return { ok: true, value: "unexpected" }; })],
		responses: [
			{ toolCalls: [
				{ id: "unknown", name: "missing", arguments: {} },
				{ id: "invalid", name: "capture", arguments: { value: [] } },
			], stopReason: "tool_use" },
			{ text: "recovered" },
		],
	});
	const events = await collect(port);
	expect(executions).toBe(0);
	for (const id of ["unknown", "invalid"]) {
		expect(events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === id)).toMatchObject([{ isError: true }]);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.toolCallId === id)).toHaveLength(1);
	}
	expect(events.at(-1)?.type).toBe("agent_end");
});

test("owned core settles thrown tool failures before the next assistant message", async () => {
	const completed: string[] = [];
	const port = createPiTestPort({
		tools: [tool(async (input) => {
			const value = (input as { value: string }).value;
			if (value === "fail") throw new Error("injected failure");
			await Bun.sleep(10);
			completed.push(value);
			return { ok: true, value };
		})],
		responses: [
			{ toolCalls: ["first", "fail", "last"].map((value) => ({ id: value, name: "capture", arguments: { value } })), stopReason: "tool_use" },
			{ text: "finished" },
		],
	});
	const events = await collect(port);
	expect(completed.sort()).toEqual(["first", "last"]);
	const assistantEnd = events.findIndex((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop");
	for (const id of ["first", "fail", "last"]) {
		const starts = events.flatMap((event, index) => event.type === "tool_execution_start" && event.toolCallId === id ? [index] : []);
		const ends = events.flatMap((event, index) => event.type === "tool_execution_end" && event.toolCallId === id ? [index] : []);
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(starts[0]!).toBeLessThan(ends[0]!);
		expect(ends[0]!).toBeLessThan(assistantEnd);
	}
});

test("owned core preserves one result per call across generated tool failures", async () => {
	await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (failures) => {
		const port = createPiTestPort({
			tools: [tool(async (input) => {
				if ((input as { value: string }).value === "fail") throw new Error("generated failure");
				return { ok: true, value: "ok" };
			})],
			responses: [
				{ toolCalls: failures.map((fail, index) => ({ id: `call-${index}`, name: "capture", arguments: { value: fail ? "fail" : "ok" } })), stopReason: "tool_use" },
				{ text: "done" },
			],
		});
		const events = await collect(port);
		const ends = events.filter((event) => event.type === "tool_execution_end");
		expect(ends).toHaveLength(failures.length);
		for (const [index, isError] of failures.entries()) {
			expect(ends.filter((event) => event.toolCallId === `call-${index}`)).toMatchObject([{ isError }]);
			expect(events.filter((event) => event.type === "message_end" && event.message.toolCallId === `call-${index}`)).toHaveLength(1);
		}
		expect(events.at(-1)?.type).toBe("agent_end");
	}), { numRuns: 25, seed: 90209 });
});

test("owned core drains steering before follow-ups and preserves FIFO in both queues", async () => {
	const port = createPiTestPort({ responses: Array.from({ length: 6 }, () => ({ echoLastUser: true })), tokensPerSecond: 500 });
	const events: SessionEvent[] = [];
	let queued = false;
	for await (const event of port.runTurn("initial")) {
		events.push(event);
		if (event.type === "message_delta" && !queued) {
			queued = true;
			port.followUp("follow-first");
			port.steer("steer-first");
			port.followUp("follow-second");
			port.steer("steer-second");
		}
	}
	expect(queued).toBe(true);
	expect(userTexts(events)).toEqual(["initial", "steer-first", "steer-second", "follow-first", "follow-second"]);
});

test("closing a tool turn aborts its signal, waits for cleanup, and discards queued inputs", async () => {
	let cleaned = false;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const port = createPiTestPort({
		tools: [tool(async (_input, context) => {
			markStarted();
			await new Promise<void>((resolve) => {
				if (context.signal?.aborted) resolve();
				else context.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			await Bun.sleep(10);
			cleaned = true;
			return { ok: true, value: "cancelled" };
		})],
		responses: [{ toolCalls: [{ id: "wait", name: "capture", arguments: { value: "wait" } }], stopReason: "tool_use" }, { echoLastUser: true }],
	});
	for await (const event of port.runTurn("discard")) {
		if (event.type === "tool_execution_start") {
			await started;
			port.steer("discard-steer");
			port.followUp("discard-follow");
			break;
		}
	}
	expect(cleaned).toBe(true);
	const events = await collect(port, "fresh");
	expect(userTexts(events)).toEqual(["fresh"]);
	expect(events.filter((event) => event.type === "turn_end")).toMatchObject([{ stopReason: "stop" }]);
});

test("concurrent owned instances isolate permissions, tools, cancellation, and stored turns", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-agent-owned-isolation-"));
	const firstBus = new RequestBus({ idPrefix: "first", timeoutMs: 1_000 });
	const secondBus = new RequestBus({ idPrefix: "second", timeoutMs: 1_000 });
	try {
		const firstStore = await SessionStore.open(join(directory, "first.jsonl"), directory);
		const secondStore = await SessionStore.open(join(directory, "second.jsonl"), directory);
		const executed: string[] = [];
		const makePort = (name: string, requestBus: RequestBus) => createPiTestPort({
			requestBus,
			permission: {},
			tools: [tool(async () => { executed.push(name); return { ok: true, value: name }; })],
			responses: [{ toolCalls: [{ id: "same-id", name: "capture", arguments: { value: name } }], stopReason: "tool_use" }, { echoLastUser: true }],
		});
		const first = new AgentRunner(makePort("first", firstBus), firstStore, firstBus);
		const second = new AgentRunner(makePort("second", secondBus), secondStore, secondBus);
		const firstRun = collect(first, "first-user");
		const secondRun = collect(second, "second-user");
		const firstRequest = await firstBus.requests()[Symbol.asyncIterator]().next();
		const secondRequest = await secondBus.requests()[Symbol.asyncIterator]().next();
		if (firstRequest.done || secondRequest.done) throw new Error("Expected independent permission requests");
		first.abort();
		expect(secondBus.respond(response(secondRequest.value.id, { decision: "allow_once" }))).toBe(true);
		const firstEvents = await firstRun;
		const secondEvents = await secondRun;
		expect(executed).toEqual(["second"]);
		expect(firstEvents.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({ stopReason: "aborted" });
		expect(secondEvents.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({ stopReason: "stop" });
		expect(firstStore.messages()).toEqual([]);
		expect(userTexts(secondEvents)).toEqual(["second-user"]);
		const reopened = await SessionStore.open(secondStore.path, directory);
		expect(reopened.messages()).toEqual(secondStore.messages());
		expect(JSON.stringify(reopened.messages())).not.toContain("first-user");
	} finally {
		firstBus.close();
		secondBus.close();
		await rm(directory, { recursive: true, force: true });
	}
});
