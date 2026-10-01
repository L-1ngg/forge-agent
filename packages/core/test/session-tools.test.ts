import { createTestAgent } from "../../../tests/support/test-agent.ts";
import { expect, test } from "bun:test";
import { permissionScopeForToolCall, response, type ToolCallBlock } from "@forge-agent/protocol";
import { MemoryPermissionStore, RequestBus } from "../src/index.ts";
import type { HarnessTool } from "@forge-agent/tools";

interface CaptureInput {
	path: string;
}

function captureTool(executed: CaptureInput[]): HarnessTool<object, unknown> {
	return {
		name: "capture",
		label: "Capture",
		description: "Capture the final tool input.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
		async execute(input) {
			executed.push(input as CaptureInput);
			return { content: [{ type: "text", text: typeof input === "string" ? input : JSON.stringify(input) }], details: input };
		},
	};
}

async function collectEvents(port: { runTurn(input: string): AsyncIterable<unknown> }): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of port.runTurn("capture")) events.push(event);
	return events;
}

async function nextPermissionRequest(bus: RequestBus) {
	const result = await bus.requests()[Symbol.asyncIterator]().next();
	if (result.done || result.value.kind !== "permission") throw new Error("Expected a permission request");
	return result.value;
}

test("SDK hooks observe isolated input and permission sees the native arguments", async () => {
	const executed: CaptureInput[] = [];
	const observedAfter: object[] = [];
	const bus = new RequestBus({ idPrefix: "rewrite-payload", timeoutMs: 1_000 });
	try {
		const port = await createTestAgent({
			responses: [
				{ toolCalls: [{ id: "capture-1", name: "capture", arguments: { path: "/tmp/file.ts" } }], stopReason: "tool_use" },
				{ text: "done" },
			],
			tools: [captureTool(executed)],
			toolHooks: {
				beforeToolCall: async ({ args }) => { Reflect.set(args, "path", "local-observation"); return undefined; },
				afterToolCall: async ({ args }) => { observedAfter.push(structuredClone(args as object)); return undefined; },
			},
			permission: { memory: new MemoryPermissionStore() },
			requestBus: bus,
		});
		const eventsPromise = collectEvents(port);
		const request = await nextPermissionRequest(bus);
		expect(request.payload.toolCall.arguments).toEqual({ path: "/tmp/file.ts" });
		bus.respond(response(request.id, { decision: "allow_once" }));

		await eventsPromise;
		expect(executed).toEqual([{ path: "/tmp/file.ts" }]);
		expect(observedAfter).toEqual([{ path: "/tmp/file.ts" }]);
	} finally {
		bus.close();
	}
});

test("a deny rule on native input prevents the underlying tool from running", async () => {
	const executed: CaptureInput[] = [];
	const port = await createTestAgent({
		responses: [{ toolCalls: [{ id: "capture-deny", name: "capture", arguments: { path: "/blocked" } }], stopReason: "tool_use" }],
		tools: [captureTool(executed)],
		permission: {
			rules: [{ tool: "capture", argsPattern: '{"path":"/blocked"}', effect: "deny", reason: "blocked path" }],
		},
	});

	const events = await collectEvents(port);
	expect(executed).toHaveLength(0);
	expect(events.some((event) => (event as { type?: string; isError?: boolean }).type === "tool_execution_end" && (event as { isError?: boolean }).isError)).toBe(true);
});

test("strict JSON Schema rejects type coercion before hooks, permission and execution", async () => {
	const executed: object[] = [];
	const authorized: object[] = [];
	let beforeCalls = 0;
	const port = await createTestAgent({
		responses: [
			{ toolCalls: [
				{ id: "invalid", name: "count", arguments: { value: "3" } },
				{ id: "valid", name: "count", arguments: { value: 3 } },
			], stopReason: "tool_use" },
			{ text: "done" },
		],
		tools: [{ name: "count", label: "Count", description: "Count", parameters: {
			type: "object", properties: { value: { type: "integer", minimum: 1 } }, required: ["value"], additionalProperties: false,
		}, async execute(input) { executed.push(structuredClone(input)); return { content: [], details: {} }; } }],
		permission: { hooks: [{ evaluate(call) { authorized.push(structuredClone(call.arguments)); return { kind: "allow", source: "hook" }; } }] },
		toolHooks: { beforeToolCall: async () => { beforeCalls++; return undefined; } },
	});
	const events = await collectEvents(port);
	const ends = events.filter((event): event is { type: "tool_execution_end"; toolCallId: string; isError: boolean } =>
		typeof event === "object" && event !== null && "type" in event && event.type === "tool_execution_end") as Array<{ type: "tool_execution_end"; toolCallId: string; isError: boolean }>;
	expect(ends.find(event => event.toolCallId === "invalid")?.isError).toBe(true);
	expect(ends.find(event => event.toolCallId === "valid")?.isError).toBe(false);
	expect(JSON.stringify(events.filter(event => typeof event === "object" && event !== null && "type" in event && event.type === "message_end"))).toContain("Validation failed");
	expect(beforeCalls).toBe(1);
	expect(authorized).toEqual([{ value: 3 }]);
	expect(executed).toEqual([{ value: 3 }]);
});

test("before hook can block valid native input before permission or execution", async () => {
	let permissions = 0;
	let executions = 0;
	const port = await createTestAgent({
		responses: [{ toolCalls: [{ id: "invalid-final", name: "count", arguments: { value: 3 } }], stopReason: "tool_use" }, { text: "done" }],
		tools: [{ name: "count", label: "Count", description: "Count", parameters: {
			type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false,
		}, async execute() { executions++; return { content: [], details: {} }; } }],
		toolHooks: { beforeToolCall: async () => ({ block: true, reason: "blocked by host" }) },
		permission: { hooks: [{ evaluate() { permissions++; return { kind: "allow", source: "hook" }; } }] },
	});
	const events = await collectEvents(port);
	expect(events.some(event => typeof event === "object" && event !== null && "type" in event && event.type === "tool_execution_end" && "isError" in event && event.isError === true)).toBe(true);
	expect(permissions).toBe(0);
	expect(executions).toBe(0);
});

test("allow_always remembers the displayed scope and permits the same call once more", async () => {
	const executed: CaptureInput[] = [];
	const memory = new MemoryPermissionStore();
	const bus = new RequestBus({ idPrefix: "rewrite-memory", timeoutMs: 500 });
	try {
		const port = await createTestAgent({
			responses: [
				{ toolCalls: [{ id: "capture-always-1", name: "capture", arguments: { path: "/tmp/file.ts" } }], stopReason: "tool_use" },
				{ toolCalls: [{ id: "capture-always-2", name: "capture", arguments: { path: "/tmp/file.ts" } }], stopReason: "tool_use" },
				{ text: "done" },
			],
			tools: [captureTool(executed)],
			permission: { memory },
			requestBus: bus,
		});
		const eventsPromise = collectEvents(port);
		const request = await nextPermissionRequest(bus);
		const displayedCall: ToolCallBlock = { type: "tool_call", id: "scope", name: "capture", arguments: { path: "/tmp/file.ts" } };
		bus.respond(response(request.id, { decision: "allow_always", scope: permissionScopeForToolCall(displayedCall) }));

		await eventsPromise;
		expect(executed).toEqual([{ path: "/tmp/file.ts" }, { path: "/tmp/file.ts" }]);
		expect(memory.entries()).toHaveLength(1);
		expect(memory.entries()[0]).toMatchObject(permissionScopeForToolCall(displayedCall));
	} finally {
		bus.close();
	}
});

test("returning the event iterator waits for the session to become idle before reuse", async () => {
	const port = await createTestAgent({ responses: [{ text: "first response" }, { text: "second response" }], tokensPerSecond: 100 });
	for await (const event of port.runTurn("first")) {
		if (event.type === "message_delta") break;
	}
	const events = await collectEvents(port);
	expect(events.some((event) => (event as { type: string }).type === "agent_end")).toBe(true);
});

test("a rejected concurrent run does not cancel the active session run", async () => {
	const port = await createTestAgent({ responses: [{ text: "complete first response" }], tokensPerSecond: 100 });
	let attempted = false;
	let stopReason: string | undefined;
	for await (const event of port.runTurn("first")) {
		if (event.type === "message_delta" && !attempted) {
			attempted = true;
			await expect(collectEvents(port)).rejects.toThrow("already");
		}
		if (event.type === "turn_end") stopReason = event.stopReason;
	}
	expect(stopReason).toBe("stop");
});

test("aborted turns retain consumed inputs in the next context", async () => {
	const port = await createTestAgent({ responses: [{ text: "discard this response" }, { text: "done" }], tokensPerSecond: 100 });
	const before = port.getUsage?.()?.contextTokens;
	for await (const event of port.runTurn("discard this prompt")) {
		if (event.type === "message_delta") port.abort();
	}
	expect(port.getUsage?.()?.contextTokens).toBeGreaterThan(before ?? 0);
	await collectEvents(port);
});
