import { expect, test } from "bun:test";
import { permissionResultFromOutcome, RequestBus } from "../../packages/core/src/index.ts";
import { response, type RequestEnvelope, type RequestKind } from "../../packages/protocol/src/index.ts";

const permissionPayload = {
	toolCall: { type: "tool_call" as const, id: "call-1", name: "write", arguments: { path: "file.txt" } },
};

test("request bus emits a request and accepts exactly one response", async () => {
	const bus = new RequestBus({ idPrefix: "test", timeoutMs: 1_000 });
	const requestIterator = bus.requests()[Symbol.asyncIterator]();
	const responseIterator = bus.responses()[Symbol.asyncIterator]();
	const pending = bus.ask("permission", permissionPayload);

	const emitted = await requestIterator.next();
	expect(emitted.done).toBe(false);
	const request = emitted.value as RequestEnvelope<"permission">;
	expect(request).toMatchObject({ type: "request", kind: "permission", payload: permissionPayload });

	const accepted = bus.respond(response(request.id, { decision: "allow_once" }));
	expect(accepted).toBe(true);
	expect(await pending).toEqual({ status: "response", requestId: request.id, result: { decision: "allow_once" } });

	const observed = await responseIterator.next();
	expect(observed.value).toEqual(response(request.id, { decision: "allow_once" }));
	expect(bus.respond(response(request.id, { decision: "deny", reason: "late" }))).toBe(false);
	expect(bus.getDroppedResponses().at(-1)?.reason).toBe("duplicate_response");
	bus.close();
});

test("permission allow_always requires a typed authorization scope", async () => {
	const bus = new RequestBus({ idPrefix: "scope", timeoutMs: 1_000 });
	const pending = bus.ask("permission", permissionPayload);
	const request = (await bus.requests()[Symbol.asyncIterator]().next()).value as RequestEnvelope<"permission">;

	expect(bus.respond(response(request.id, { decision: "allow_always" }))).toBe(false);
	expect(bus.respond(response(request.id, { decision: "allow_always", scope: { tool: "", argsPattern: "*.txt" } }))).toBe(false);
	expect(bus.respond(response(request.id, { decision: "allow_always", scope: { tool: "write", argsPattern: "" } }))).toBe(false);
	expect(bus.respond(response(request.id, { decision: "allow_always", scope: { tool: "write", argsPattern: "*.txt" } }))).toBe(true);
	expect(await pending).toEqual({
		status: "response",
		requestId: request.id,
		result: { decision: "allow_always", scope: { tool: "write", argsPattern: "*.txt" } },
	});
	expect(bus.getDroppedResponses().at(-1)?.reason).toBe("invalid_response");
	bus.close();
});

test("permission allow_always rejects malformed scope fields", async () => {
	const bus = new RequestBus({ idPrefix: "scope-invalid", timeoutMs: 1_000 });
	const pending = bus.ask("permission", permissionPayload);
	const request = (await bus.requests()[Symbol.asyncIterator]().next()).value as RequestEnvelope<"permission">;

	expect(bus.respond(response(request.id, { decision: "allow_always", scope: { tool: "write" } }))).toBe(false);
	expect(bus.respond(response(request.id, { decision: "allow_always", scope: { tool: "write", argsPattern: 42 } }))).toBe(false);
	expect(bus.pendingCount).toBe(1);
	bus.respond(response(request.id, { decision: "deny", reason: "not remembered" }));
	expect(await pending).toMatchObject({ status: "response", result: { decision: "deny" } });
	bus.close();
});

test("timeout and abort are terminal and permission cancellation maps to deny", async () => {
	const bus = new RequestBus({ idPrefix: "terminal", timeoutMs: 1_000 });
	const terminalIterator = bus.terminals()[Symbol.asyncIterator]();
	const timedOut = bus.ask("permission", permissionPayload, { timeoutMs: 5 });
	const aborted = bus.ask("permission", { ...permissionPayload, toolCall: { ...permissionPayload.toolCall, id: "call-2" } });

	const timeoutOutcome = await timedOut;
	expect(timeoutOutcome.status).toBe("timeout");
	expect((await terminalIterator.next()).value).toEqual(timeoutOutcome);
	expect(bus.abort()).toBe(1);
	const abortOutcome = await aborted;
	expect(abortOutcome).toMatchObject({ status: "cancelled", reason: "aborted" });
	expect((await terminalIterator.next()).value).toEqual(abortOutcome);
	expect(permissionResultFromOutcome(abortOutcome)).toMatchObject({ decision: "deny" });

	const before = bus.getTerminal(abortOutcome.requestId);
	expect(bus.respond(response(abortOutcome.requestId, { decision: "allow_once" }))).toBe(false);
	expect(bus.getTerminal(abortOutcome.requestId)).toEqual(before);
	expect(bus.getDroppedResponses().map((record) => record.reason)).toEqual(["late_response"]);
	bus.close();
});

test("null timeout keeps an interactive request pending until an explicit response", async () => {
	const bus = new RequestBus({ idPrefix: "interactive", timeoutMs: null });
	const pending = bus.ask("permission", permissionPayload);
	const request = (await bus.requests()[Symbol.asyncIterator]().next()).value as RequestEnvelope<"permission">;

	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(bus.pendingCount).toBe(1);
	expect(bus.getTerminal(request.id)).toBeUndefined();
	bus.respond(response(request.id, { decision: "allow_once" }));
	expect(await pending).toMatchObject({ status: "response", result: { decision: "allow_once" } });
	bus.close();
});

test("unknown and malformed responses are dropped without changing pending state", async () => {
	const drops: string[] = [];
	const bus = new RequestBus({ idPrefix: "drop", timeoutMs: 1_000, onDrop: (record) => drops.push(record.reason) });
	const pending = bus.ask("permission", permissionPayload);
	const request = (await bus.requests()[Symbol.asyncIterator]().next()).value as RequestEnvelope<"permission">;

	expect(bus.respond({ type: "response", id: "unknown", result: { decision: "allow_once" } })).toBe(false);
	expect(bus.respond({ type: "not-a-response", id: request.id })).toBe(false);
	expect(bus.respond(response(request.id, { decision: "approve" }))).toBe(false);
	expect(bus.pendingCount).toBe(1);
	bus.respond(response(request.id, { decision: "deny" }));
	expect((await pending).status).toBe("response");
	expect(drops).toEqual(["unknown_id", "invalid_response", "invalid_response"]);
	bus.close();
});

test("abort signal cancels before a request is emitted and uses the abort reason", async () => {
	const controller = new AbortController();
	controller.abort();
	const bus = new RequestBus({ idPrefix: "signal", timeoutMs: 1_000 });
	const outcome = await bus.ask("permission", permissionPayload, { signal: controller.signal });
	expect(outcome).toMatchObject({ status: "cancelled", reason: "aborted" });
	const nextRequest = bus.requests()[Symbol.asyncIterator]().next();
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(bus.pendingCount).toBe(0);
	bus.close();
	expect((await nextRequest).done).toBe(true);
});

test("default ids remain unique across buses even with the same prefix", async () => {
	const first = new RequestBus({ idPrefix: "same", timeoutMs: 1_000 });
	const second = new RequestBus({ idPrefix: "same", timeoutMs: 1_000 });
	const firstPending = first.ask("permission", permissionPayload);
	const secondPending = second.ask("permission", permissionPayload);
	const firstId = ((await first.requests()[Symbol.asyncIterator]().next()).value as { id: string }).id;
	const secondId = ((await second.requests()[Symbol.asyncIterator]().next()).value as { id: string }).id;
	expect(firstId).not.toBe(secondId);
	first.respond(response(firstId, { decision: "deny" }));
	second.respond(response(secondId, { decision: "deny" }));
	await Promise.all([firstPending, secondPending]);
	first.close();
	second.close();
});

test("all five request kinds have a typed envelope", async () => {
	const requests: Array<[RequestKind, RequestEnvelope]> = [
		["permission", { type: "request", id: "p", kind: "permission", payload: permissionPayload }],
		["cancel_confirm", { type: "request", id: "c", kind: "cancel_confirm", payload: { action: "stop" } }],
		["question", { type: "request", id: "q", kind: "question", payload: { prompt: "continue?" } }],
		["plan_approval", { type: "request", id: "a", kind: "plan_approval", payload: { plan: "do it" } }],
		["oauth", { type: "request", id: "o", kind: "oauth", payload: { provider: "example", authorizationUrl: "https://example.test" } }],
	];
	expect(requests.map(([kind, envelope]) => [kind, envelope.kind])).toEqual(requests.map(([kind]) => [kind, kind]));
});
