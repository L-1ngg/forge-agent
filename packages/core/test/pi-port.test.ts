import { expect, test } from "bun:test";
import { permissionScopeForToolCall, response, type ToolCallBlock } from "@myh/protocol";
import { createPiTestPort, MemoryPermissionStore, RequestBus } from "../src/index.ts";
import type { HarnessTool } from "@myh/tools";

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
			return { ok: true, value: input };
		},
	};
}

function rewriteToSafePath(input: object): object {
	const value = input as CaptureInput;
	return { ...value, path: value.path.replace(/^\//, "") };
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

test("pi authorizes the rewritten input and sends that object on the permission bus", async () => {
	const executed: CaptureInput[] = [];
	let rewriteCount = 0;
	const bus = new RequestBus({ idPrefix: "rewrite-payload", timeoutMs: 1_000 });
	try {
		const port = createPiTestPort({
			responses: [
				{ toolCalls: [{ id: "capture-1", name: "capture", arguments: { path: "/tmp/file.ts" } }], stopReason: "tool_use" },
				{ text: "done" },
			],
			tools: [captureTool(executed)],
			toolInputRewrites: {
				capture: (input) => {
					rewriteCount++;
					return rewriteToSafePath(input);
				},
			},
			permission: { memory: new MemoryPermissionStore() },
			requestBus: bus,
		});
		const eventsPromise = collectEvents(port);
		const request = await nextPermissionRequest(bus);
		expect(request.payload.toolCall.arguments).toEqual({ path: "tmp/file.ts" });
		bus.respond(response(request.id, { decision: "allow_once" }));

		await eventsPromise;
		expect(rewriteCount).toBe(1);
		expect(executed).toEqual([{ path: "tmp/file.ts" }]);
	} finally {
		bus.close();
	}
});

test("a deny rule evaluated on rewritten input prevents the underlying tool from running", async () => {
	const executed: CaptureInput[] = [];
	let rewriteCount = 0;
	const port = createPiTestPort({
		responses: [{ toolCalls: [{ id: "capture-deny", name: "capture", arguments: { path: "/blocked" } }], stopReason: "tool_use" }],
		tools: [captureTool(executed)],
		toolInputRewrites: {
			capture: (input) => {
				rewriteCount++;
				return rewriteToSafePath(input);
			},
		},
		permission: {
			rules: [{ tool: "capture", argsPattern: '{"path":"blocked"}', effect: "deny", reason: "blocked final path" }],
		},
	});

	const events = await collectEvents(port);
	expect(rewriteCount).toBe(1);
	expect(executed).toHaveLength(0);
	expect(events.some((event) => (event as { type?: string; isError?: boolean }).type === "tool_execution_end" && (event as { isError?: boolean }).isError)).toBe(true);
});

test("allow_always remembers the rewritten scope and permits the same rewritten call once more", async () => {
	const executed: CaptureInput[] = [];
	const memory = new MemoryPermissionStore();
	const bus = new RequestBus({ idPrefix: "rewrite-memory", timeoutMs: 500 });
	try {
		const port = createPiTestPort({
			responses: [
				{ toolCalls: [{ id: "capture-always-1", name: "capture", arguments: { path: "/tmp/file.ts" } }], stopReason: "tool_use" },
				{ toolCalls: [{ id: "capture-always-2", name: "capture", arguments: { path: "/tmp/file.ts" } }], stopReason: "tool_use" },
				{ text: "done" },
			],
			tools: [captureTool(executed)],
			toolInputRewrites: { capture: rewriteToSafePath },
			permission: { memory },
			requestBus: bus,
		});
		const eventsPromise = collectEvents(port);
		const request = await nextPermissionRequest(bus);
		const rewrittenCall: ToolCallBlock = { type: "tool_call", id: "scope", name: "capture", arguments: { path: "tmp/file.ts" } };
		bus.respond(response(request.id, { decision: "allow_always", scope: permissionScopeForToolCall(rewrittenCall) }));

		await eventsPromise;
		expect(executed).toEqual([{ path: "tmp/file.ts" }, { path: "tmp/file.ts" }]);
		expect(memory.entries()).toHaveLength(1);
		expect(memory.entries()[0]).toMatchObject(permissionScopeForToolCall(rewrittenCall));
	} finally {
		bus.close();
	}
});

test("returning the event iterator waits for pi to become idle before reuse", async () => {
	const port = createPiTestPort({ responses: [{ text: "first response" }, { text: "second response" }], tokensPerSecond: 100 });
	for await (const event of port.runTurn("first")) {
		if (event.type === "message_delta") break;
	}
	const events = await collectEvents(port);
	expect(events.some((event) => (event as { type: string }).type === "agent_end")).toBe(true);
});

test("a rejected concurrent run does not cancel the active pi run", async () => {
	const port = createPiTestPort({ responses: [{ text: "complete first response" }], tokensPerSecond: 100 });
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

test("aborted pi turns do not remain in the next context", async () => {
	const port = createPiTestPort({ responses: [{ text: "discard this response" }, { text: "done" }], tokensPerSecond: 100 });
	const before = port.getUsage?.()?.contextTokens;
	for await (const event of port.runTurn("discard this prompt")) {
		if (event.type === "message_delta") port.abort();
	}
	expect(port.getUsage?.()?.contextTokens).toBe(before);
	await collectEvents(port);
});
