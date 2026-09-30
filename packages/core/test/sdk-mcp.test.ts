import { test, expect } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createAgent, MemorySessionStorage } from "../src/sdk.ts";
import { mcpFixture, calls } from "./helpers/mcp-server.ts";
import { modelResponse, gate } from "../../../tests/fixtures/model-response.ts";
import { mcpToolName } from "../src/mcp/config.ts";
import { sessionMessages } from "../src/session-storage.ts";
const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "BASE", thinkingLevel: "off" as const, cwd: process.cwd() };
const allow = { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] };
function remote() { const handler = createMcpHandler(mcpFixture); const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler.fetch(request) }); return { url: `http://127.0.0.1:${listener.port}/mcp`, async close() { await listener.stop(true); await handler.close(); } }; }
for (const transport of ["http", "stdio"] as const) for (const protocol of ["legacy", "auto", "2026-07-28"] as const) test(`MCP public SDK ${transport}/${protocol}: catalogs, completion, read, tool/model continuation, cleanup`, async () => {
	const fixture = remote(); let requests = 0; const storage = new MemorySessionStorage();
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { const body = await request.json(); if (++requests === 1) { expect(JSON.stringify(body)).toContain(mcpToolName("fixture", "echo")); return modelResponse([{ id: "echo", name: mcpToolName("fixture", "echo"), arguments: { value: "VERIFIED" } }]); } expect(JSON.stringify(body)).toContain("VERIFIED"); return modelResponse(); } });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: allow, storage, mcp: { servers: { fixture: transport === "http" ? { transport, protocol, url: fixture.url } : { transport, protocol, command: process.execPath, args: [import.meta.dir + "/helpers/mcp-server.ts"] } } } });
	try {
		expect(agent.mcp.snapshot().servers[0]?.state).toBe("ready");
		expect(await agent.mcp.listResources("fixture")).toHaveLength(1); expect(await agent.mcp.listResourceTemplates("fixture")).toHaveLength(1); expect(await agent.mcp.listPrompts("fixture")).toHaveLength(1);
		expect(await agent.mcp.complete("fixture", { type: "ref/resource", uri: "fixture://item/{id}" }, { name: "id", value: "" })).toEqual(["one", "two"]);
		expect(JSON.stringify(await agent.mcp.readResource("fixture", "fixture://data"))).toContain("RESOURCE EVIDENCE");
		const turn = agent.runTurn("Echo"); for await (const _event of turn) {} expect(await turn.result).toEqual({ status: "success" }); expect(requests).toBe(2);
		expect(sessionMessages(await storage.load()).filter(message => message.role === "toolResult")).toHaveLength(1);
		const firstGeneration = agent.mcp.snapshot().servers[0]!.connectionGeneration; await (await agent.mcp.refresh()).applied; expect(agent.mcp.snapshot().servers[0]!.connectionGeneration).toBe(firstGeneration);
	} finally { await agent.dispose(); await agent.dispose(); await fixture.close(); await model.stop(true); }
}, 15000);

test("MCP permission refusal sends zero resource/tool business calls; annotations do not authorize", async () => {
	calls.length = 0; const fixture = remote(); let requests = 0;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => ++requests === 1 ? modelResponse([{ id: "echo", name: mcpToolName("fixture", "echo"), arguments: { value: "denied" } }]) : modelResponse() });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: { mode: "deny-all" }, mcp: { servers: { fixture: { transport: "http", url: fixture.url } } } });
	try { await expect(agent.mcp.readResource("fixture", "fixture://data")).rejects.toThrow("deny-all"); const turn = agent.runTurn("deny"); for await (const _event of turn) {} expect(calls).toHaveLength(0); expect(requests).toBe(2); }
	finally { await agent.dispose(); await fixture.close(); await model.stop(true); }
});

test("MCP prompt is one durable envelope, ordered request roles, literal task, and restore does not refetch", async () => {
	calls.length = 0; const fixture = remote(); const storage = new MemorySessionStorage(); const task = '  literal "task"\nend  ';
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { const body = await request.json(); const text = JSON.stringify(body); expect(text).toContain("TEMPLATE subject"); expect(text).toContain("EXTERNAL ASSISTANT CONTEXT"); expect(text).toContain(JSON.stringify(task).slice(1, -1)); return modelResponse(); } });
	const options = { ...base, baseUrl: `http://127.0.0.1:${model.port}`, storage, permission: allow, mcp: { servers: { fixture: { transport: "http" as const, url: fixture.url } } } };
	let agent = await createAgent(options);
	try { for await (const _event of agent.runTurn({ kind: "mcp_prompt", serverId: "fixture", name: "template", arguments: { subject: "subject" }, task })) {} const messages = sessionMessages(await storage.load()); expect(messages.filter(message => message.role === "user")).toHaveLength(1); expect(messages[0]?.inputContext?.messages.map(message => message.role)).toEqual(["user", "assistant"]); await agent.dispose(); agent = await createAgent(options); for await (const _event of agent.runTurn("Continue")) {} expect(calls.filter(call => call.name === "prompt")).toHaveLength(1); }
	finally { await agent.dispose(); await fixture.close(); await model.stop(true); }
});

test("MCP configuration receipt preserves the current model response and whole tool batch", async () => {
	calls.length = 0; const fixture = remote(), started = gate(), release = gate(); let requests = 0;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { if (++requests === 1) { started.resolve(); await release.promise; return modelResponse([{ id: "a", name: mcpToolName("fixture", "echo"), arguments: { value: "a" } }, { id: "b", name: mcpToolName("fixture", "echo"), arguments: { value: "b" } }]); } return modelResponse(); } });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: allow, mcp: { servers: { fixture: { transport: "http", url: fixture.url } } } });
	try { const running = (async () => { for await (const _event of agent.runTurn("work")) {} })(); await started.promise; const receipt = await agent.mcp.setEnabled("fixture", false); let applied = false; void receipt.applied.then(() => { applied = true; }); await new Promise(resolve => setTimeout(resolve, 10)); expect(applied).toBe(false); release.resolve(); await running; expect((await receipt.applied).status).toBe("applied"); expect(calls.filter(call => call.name === "echo")).toHaveLength(2); expect(agent.mcp.snapshot().servers[0]?.state).toBe("disabled"); }
	finally { release.resolve(); await agent.dispose(); await fixture.close(); await model.stop(true); }
});

test("MCP final rewritten arguments are exact; invalid schema input never reaches server", async () => {
	calls.length = 0; const fixture = remote(); let requests = 0;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++requests === 1 ? modelResponse([{ id: "echo", name: mcpToolName("fixture", "echo"), arguments: { value: "original" } }]) : modelResponse(); } });
	let authorized: unknown;
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: allow, toolInputRewrites: { [mcpToolName("fixture", "echo")]: () => ({ value: "rewritten" }) }, toolHooks: { beforeToolCall: async context => { authorized = structuredClone(context.args); return undefined; } }, mcp: { servers: { fixture: { transport: "http", url: fixture.url } } } });
	try { for await (const _event of agent.runTurn("rewrite")) {} expect(authorized).toEqual({ value: "rewritten" }); expect(calls).toEqual([{ name: "echo", args: { value: "rewritten" } }]); }
	finally { await agent.dispose(); await fixture.close(); await model.stop(true); }
});

for (const mode of ["form", "url"] as const) for (const decision of ["accept", "decline", "cancel"] as const) test(`MCP ${mode} elicitation ${decision} through public requests/respond`, async () => {
	const fixture = remote(); let requests = 0; const storage = new MemorySessionStorage();
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => ++requests === 1 ? modelResponse([{ id: "form", name: mcpToolName("fixture", mode), arguments: {} }]) : modelResponse() });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: allow, storage, mcp: { servers: { fixture: { transport: "http", url: fixture.url } } } });
	let interactions = 0; const consumer = (async () => { for await (const request of agent.requests) { expect(request.kind).toBe("mcp_elicitation"); interactions++; expect(agent.respond({ type: "response", id: request.id, result: decision === "accept" && mode === "form" ? { decision, content: { count: 7 } } : { decision } })).toBe(true); expect(agent.respond({ type: "response", id: request.id, result: { decision: "accept", content: { count: 99 } } })).toBe(false); } })();
	try { for await (const _event of agent.runTurn("form")) {} expect(interactions).toBe(1); const result = sessionMessages(await storage.load()).find(message => message.role === "toolResult"); expect(result?.isError).toBe(false); expect(JSON.stringify(result)).toContain(decision); }
	finally { await agent.dispose(); await consumer; await fixture.close(); await model.stop(true); }
});

test("MCP preserves binary attachment bytes and output validation failures", async () => {
	const fixture = remote(); let requests = 0; const storage = new MemorySessionStorage();
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => ++requests === 1 ? modelResponse([{ id: "media", name: mcpToolName("fixture", "media"), arguments: {} }, { id: "bad", name: mcpToolName("fixture", "bad_output"), arguments: {} }]) : modelResponse() });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, storage, permission: allow, mcp: { servers: { fixture: { transport: "http", url: fixture.url } } } });
	try { for await (const _event of agent.runTurn("media")) {} const results = sessionMessages(await storage.load()).filter(message => message.role === "toolResult"); expect(results[1]?.isError).toBe(true); const details = results[0]?.details as { artifacts: Array<{ id: string }> }; const saved = await agent.mcp.readArtifact(details.artifacts[0]!.id); expect(Buffer.from(saved.bytes).toString()).toBe("original audio"); expect(JSON.stringify(results[0])).toContain("fixture://data"); }
	finally { await agent.dispose(); await fixture.close(); await model.stop(true); }
});

test("MCP ignored cancellation settles locally, never replays business call, subsequent turn recovers", async () => {
	calls.length = 0; const fixture = remote(); let requests = 0;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => ++requests === 1 ? modelResponse([{ id: "slow", name: mcpToolName("fixture", "slow"), arguments: {} }]) : modelResponse() });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: allow, mcp: { servers: { fixture: { transport: "http", url: fixture.url, timeouts: { tool: 50, total: 100 } } } } });
	try { const start = Date.now(); const turn = agent.runTurn("timeout"); for await (const _event of turn) {} expect(Date.now() - start).toBeLessThan(1000); expect(calls.filter(call => call.name === "slow")).toHaveLength(1); for await (const _event of agent.runTurn("recover")) {} expect(calls.filter(call => call.name === "slow")).toHaveLength(1); }
	finally { await agent.dispose(); await fixture.close(); await model.stop(true); }
});

test("MCP partial startup and invalid update preserve available server and disabled means zero connections", async () => {
	const fixture = remote(); const agent = await createAgent({ ...base, permission: allow, mcp: { servers: { good: { transport: "http", url: fixture.url }, bad: { transport: "stdio", command: "/nonexistent-forge-mcp-fixture" } } } });
	try { expect(agent.mcp.snapshot().servers.map(server => server.state)).toEqual(["failed", "ready"]); await expect(agent.updateConfiguration({ mcp: { servers: { good: { transport: "http", url: "invalid" } } } })).rejects.toThrow("url"); expect(agent.mcp.snapshot().servers.find(server => server.serverId === "good")?.state).toBe("ready"); }
	finally { await agent.dispose(); await fixture.close(); }
	const disabled = await createAgent({ ...base, mcp: false }); try { expect(disabled.mcp.snapshot().enabled).toBe(false); await expect(disabled.mcp.refresh()).rejects.toThrow("disabled"); } finally { await disabled.dispose(); }
});


test("MCP complex schema retains local refs/oneOf in provider request and refuses coercion before permission", async () => {
 calls.length = 0; const fixture = remote(); let requests = 0; let authorized = 0;
 const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
   const body = await request.json(); const tool = body.tools.find((tool: { name: string }) => tool.name === mcpToolName("fixture", "complex"));
   expect(tool.input_schema.$defs.positive.minimum).toBe(1); expect(tool.input_schema.oneOf).toHaveLength(2); expect(tool.input_schema.additionalProperties).toBe(true);
   return ++requests === 1 ? modelResponse([{ id: "invalid", name: tool.name, arguments: { value: "3" } }, { id: "valid", name: tool.name, arguments: { value: 3, extra: { nested: "kept" } } }]) : modelResponse();
 } });
 const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: allow, toolHooks: { beforeToolCall: async () => { authorized++; return undefined; } }, mcp: { servers: { fixture: { transport: "http", url: fixture.url } } } });
 try { for await (const _event of agent.runTurn("complex")) {} expect(authorized).toBe(1); expect(calls.filter(call => call.name === "complex")).toEqual([{ name: "complex", args: { value: 3, extra: { nested: "kept" } } }]); }
 finally { await agent.dispose(); await fixture.close(); await model.stop(true); }
});
