import { expect, test } from "bun:test";
import { createPiTestPort, MemoryPermissionStore, decide, type PermissionContext } from "../src/index.ts";
import { RequestBus } from "../src/request-bus.ts";
import { permissionScopeForToolCall, response } from "@forge-agent/protocol";
import type { ToolCallBlock } from "@forge-agent/protocol";

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
	for (const command of ["  rm -rf tmp", "echo ok;\n  chmod 777 file", "sudo kill 123", "git push origin main"]) {
		expect(decide(bashCall(command), { memory }).kind).toBe("ask");
	}
	const explicitlyRememberable = decide(bashCall("rm -rf tmp"), { rememberable: true, memory });
	expect(explicitlyRememberable.kind).toBe("ask");
	if (explicitlyRememberable.kind === "ask") expect(explicitlyRememberable.payload.rememberRule).toBeUndefined();
});

test("an explicit built-in deny remains authoritative for dangerous calls", () => {
	const decision = decide(bashCall("rm -rf tmp"), {
		builtInAutoApprove: [{ tool: "bash", argsPattern: "*", effect: "deny", reason: "blocked by policy" }],
	});
	expect(decision).toEqual({ kind: "deny", source: "built-in", reason: "blocked by policy" });
});

test("a deny wins over an allow when multiple rules in one layer match", () => {
	const decision = decide(readCall, {
		rules: [
			{ tool: "read", argsPattern: "*", effect: "allow" },
			{ tool: "read", argsPattern: "*", effect: "deny", reason: "blocked by project policy" },
		],
	});
	expect(decision).toEqual({ kind: "deny", source: "rule", reason: "blocked by project policy" });
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

test("session tool policy blocks deny and remembers only the scope shown", async () => {
 const invoke = async (context: PermissionContext, call = writeCall, requestBus?: RequestBus) => {
  const port = createPiTestPort({ permission: context, ...(requestBus ? { requestBus } : {}),
   tools: [{ name: call.name, label: "Policy fixture", description: "No effects", parameters: { type: "object", properties: Object.fromEntries(Object.keys(call.arguments).map(key => [key, { type: "string" }])), required: [], additionalProperties: false }, async execute() { return { content: [], details: {} }; } }],
   responses: [{ toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments }] }, { text: "done" }],
  });
  for await (const event of port.runTurn("policy")) if (event.type === "tool_execution_end") return event;
  throw new Error("Missing tool outcome");
 };
 expect(await invoke({ mode: "deny-all" })).toMatchObject({ isError: true });
 for (const scenario of ["exact", "widened", "dangerous"] as const) {
  const bus = new RequestBus({ timeoutMs: 1000 }); const memory = new MemoryPermissionStore();
  const call = scenario === "dangerous" ? { ...writeCall, name: "bash", arguments: { command: "rm -rf tmp" } } : writeCall;
  try {
   const pending = invoke({ memory }, call, bus);
   const request = (await bus.requests()[Symbol.asyncIterator]().next()).value;
   expect(request.kind).toBe("permission");
   bus.respond(response(request.id, { decision: "allow_always", scope: scenario === "widened" ? { tool: "write", argsPattern: "*" } : permissionScopeForToolCall(call) }));
   const result = await pending;
   expect(result.isError).toBe(scenario !== "exact"); expect(memory.entries()).toHaveLength(scenario === "exact" ? 1 : 0);
   if (scenario !== "exact") expect(result.content).toContain(scenario === "widened" ? "differs" : "unavailable");
  } finally { bus.close(); }
 }
});
