import { expect, test } from "bun:test";
import { createPermissionBeforeToolCall, MemoryPermissionStore, decide, type PermissionContext } from "../src/index.ts";
import { RequestBus } from "../src/request-bus.ts";
import { permissionScopeForToolCall, response } from "@myh/protocol";
import type { ToolCallBlock } from "@myh/protocol";

const readCall: ToolCallBlock = {
	type: "tool_call",
	id: "read-1",
	name: "read",
	arguments: { path: "README.md" },
};

const writeCall: ToolCallBlock = {
	type: "tool_call",
	id: "write-1",
	name: "write",
	arguments: { path: "src/index.ts", content: "export {};" },
};

const bashCall = (command: string): ToolCallBlock => ({
	type: "tool_call",
	id: `bash-${command}`,
	name: "bash",
	arguments: { command },
});

test("permission layers are independently observable and ordered", () => {
	const hookDeny = decide(readCall, {
		hooks: [{ evaluate: () => ({ kind: "deny", source: "hook", reason: "hook denied" }) }],
		rules: [{ tool: "read", argsPattern: "*", effect: "allow" }],
	});
	const ruleDeny = decide(readCall, {
		rules: [{ tool: "read", argsPattern: "*", effect: "deny", reason: "rule denied" }],
		memory: new MemoryPermissionStore([{ tool: "read", argsPattern: "*" }]),
	});
	const rememberedAllow = decide(readCall, {
		memory: new MemoryPermissionStore([{ tool: "read", argsPattern: "*" }]),
		builtInAutoApprove: [{ tool: "read", argsPattern: "*", effect: "deny", reason: "later deny" }],
	});
	const builtInAllow = decide(readCall, {
		builtInAutoApprove: [{ tool: "read", argsPattern: "*", effect: "allow" }],
		mode: "deny-all",
	});
	const builtInDeny = decide(readCall, {
		builtInAutoApprove: [{ tool: "read", argsPattern: "*", effect: "deny", reason: "built-in denied" }],
	});
	const modeDeny = decide(readCall, { mode: "deny-all" });
	const modeAllow = decide(writeCall, { mode: "accept-edits" });

	expect(hookDeny).toMatchObject({ kind: "deny", source: "hook" });
	expect(ruleDeny).toMatchObject({ kind: "deny", source: "rule" });
	expect(rememberedAllow).toEqual({ kind: "allow", source: "remembered" });
	expect(builtInAllow).toEqual({ kind: "allow", source: "built-in" });
	expect(builtInDeny).toEqual({ kind: "deny", source: "built-in", reason: "built-in denied" });
	expect(modeDeny).toMatchObject({ kind: "deny", source: "mode" });
	expect(modeAllow).toEqual({ kind: "allow", source: "mode" });
});

test("dangerous commands still ask despite remembered or explicit allow rules", () => {
	const memory = new MemoryPermissionStore([{ tool: "bash", argsPattern: "*" }]);
	for (const command of ["rm -rf tmp", "chmod 777 file", "kill 123", "git push origin main"]) {
		const decision = decide(bashCall(command), {
			memory,
			rules: [{ tool: "bash", argsPattern: "*", effect: "allow" }],
			builtInAutoApprove: [{ tool: "bash", argsPattern: "*", effect: "allow" }],
		});
		expect(decision.kind).toBe("ask");
		if (decision.kind === "ask") expect(decision.payload.rememberRule).toBeUndefined();
	}
	const explicitlyRememberable = decide(bashCall("rm -rf tmp"), { rememberable: true, memory });
	expect(explicitlyRememberable.kind).toBe("ask");
	if (explicitlyRememberable.kind === "ask") expect(explicitlyRememberable.payload.rememberRule).toBeUndefined();
});

test("Always allow is omitted when no memory store can honor it", () => {
	const decision = decide(readCall);
	expect(decision).toMatchObject({ kind: "ask" });
	if (decision.kind === "ask") expect(decision.payload.rememberRule).toBeUndefined();
});

test("an unrememberable request does not advertise Always allow", () => {
	const decision = decide(readCall, { rememberable: false });
	expect(decision).toMatchObject({ kind: "ask" });
	if (decision.kind === "ask") expect(decision.payload).not.toHaveProperty("rememberRule");
});

test("remembered authorization contains the object scope", () => {
	const memory = new MemoryPermissionStore([{ tool: "write", argsPattern: '{"content":"export {};","path":"src/index.ts"}' }]);
	expect(decide(writeCall, { memory })).toEqual({ kind: "allow", source: "remembered" });
	const differentObject = { ...writeCall, arguments: { ...writeCall.arguments, path: "src/other.ts" } };
	const decision = decide(differentObject, { memory });
	expect(decision.kind).toBe("ask");
});

test("remembered scopes treat wildcard characters in argument values literally", () => {
	const call = { ...writeCall, arguments: { path: "src/*.ts", content: "value?" } };
	const memory = new MemoryPermissionStore();
	memory.remember(permissionScopeForToolCall(call));
	expect(decide(call, { memory })).toEqual({ kind: "allow", source: "remembered" });
	const different = { ...call, arguments: { path: "src/other.ts", content: "valueX" } };
	expect(decide(different, { memory }).kind).toBe("ask");
});

test("beforeToolCall adapter blocks deny decisions and remembers only the scope shown for the call", async () => {
	const blocked = createPermissionBeforeToolCall({ context: { mode: "deny-all" } });
	const blockedResult = await blocked({
		toolCall: { type: "toolCall", id: "call-1", name: "write", arguments: writeCall.arguments },
		args: writeCall.arguments,
	} as never);
	expect(blockedResult).toMatchObject({ block: true, terminate: true });

	const bus = new RequestBus({ idPrefix: "permission-test", timeoutMs: 1_000 });
	const memory = new MemoryPermissionStore();
	const context: PermissionContext = { memory };
	const adapter = createPermissionBeforeToolCall({ context, requestBus: bus });
	const pending = adapter({
		toolCall: { type: "toolCall", id: "call-2", name: "write", arguments: writeCall.arguments },
		args: writeCall.arguments,
	} as never);
	const request = (await bus.requests()[Symbol.asyncIterator]().next()).value;
	expect(request.kind).toBe("permission");
	bus.respond(response(request.id, { decision: "allow_always", scope: permissionScopeForToolCall(writeCall) }));
	expect(await pending).toBeUndefined();
	expect(memory.entries()).toHaveLength(1);
	bus.close();

	const widenedBus = new RequestBus({ idPrefix: "permission-widened", timeoutMs: 1_000 });
	const widenedMemory = new MemoryPermissionStore();
	const widenedAdapter = createPermissionBeforeToolCall({ context: { memory: widenedMemory }, requestBus: widenedBus });
	const widenedPending = widenedAdapter({
		toolCall: { type: "toolCall", id: "call-3", name: "write", arguments: writeCall.arguments },
		args: writeCall.arguments,
	} as never);
	const widenedRequest = (await widenedBus.requests()[Symbol.asyncIterator]().next()).value;
	widenedBus.respond(response(widenedRequest.id, { decision: "allow_always", scope: { tool: "write", argsPattern: "*" } }));
	expect(await widenedPending).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("differs") });
	expect(widenedMemory.entries()).toHaveLength(0);
	widenedBus.close();

	const dangerousBus = new RequestBus({ idPrefix: "permission-dangerous", timeoutMs: 1_000 });
	const dangerousMemory = new MemoryPermissionStore();
	const dangerousAdapter = createPermissionBeforeToolCall({ context: { memory: dangerousMemory }, requestBus: dangerousBus });
	const dangerousPending = dangerousAdapter({
		toolCall: { type: "toolCall", id: "call-dangerous", name: "bash", arguments: { command: "rm -rf tmp" } },
		args: { command: "rm -rf tmp" },
	} as never);
	const dangerousRequest = (await dangerousBus.requests()[Symbol.asyncIterator]().next()).value;
	dangerousBus.respond(response(dangerousRequest.id, { decision: "allow_always", scope: permissionScopeForToolCall({ name: "bash", arguments: { command: "rm -rf tmp" } } as never) }));
	expect(await dangerousPending).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("unavailable") });
	expect(dangerousMemory.entries()).toHaveLength(0);
	dangerousBus.close();
});
