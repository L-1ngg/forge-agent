import { test, expect } from "bun:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createAgent, MemorySessionStorage } from "../src/sdk.ts";
import { sessionMessages } from "../src/session-storage.ts";
import { mcpFixture } from "./helpers/mcp-server.ts";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";
import { mcpToolName } from "../src/mcp/config.ts";

const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "base", cwd: process.cwd() };
const allow = { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] };
function serve(factory: () => McpServer) {
	const handler = createMcpHandler(factory);
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler.fetch(request) });
	return { url: `http://127.0.0.1:${listener.port}/mcp`, async close() { await listener.stop(true); await handler.close(); } };
}

test("MCP missing environment is isolated, filters match usable snapshot, and Agents do not share disposal or permission", async () => {
	const server = serve(mcpFixture);
	const mcp = { servers: { good: { transport: "http" as const, url: server.url, tools: { include: ["echo"] } }, missing: { transport: "http" as const, url: server.url, headers: { Authorization: "${FORGE_MCP_TEST_DEFINITELY_MISSING_86722}" } } } };
	const first = await createAgent({ ...base, permission: { mode: "deny-all" }, mcp });
	const second = await createAgent({ ...base, permission: allow, mcp });
	try {
		expect(first.mcp.snapshot().servers.map(server => server.state)).toEqual(["ready", "failed"]);
		expect(first.mcp.snapshot().servers[0]!.tools.map(tool => tool.remoteName)).toEqual(["echo"]);
		await expect(first.mcp.readResource("good", "fixture://data")).rejects.toThrow("deny-all");
		const disposedController = first.mcp; await first.dispose();
		expect(JSON.stringify(await second.mcp.readResource("good", "fixture://data"))).toContain("RESOURCE EVIDENCE");
		await expect(disposedController.readArtifact("unknown")).rejects.toThrow("disposed");
	} finally { await first.dispose(); await second.dispose(); await server.close(); }
});

for (const mode of ["two", "loop", "limit"] as const) test(`MCP official pagination aggregates pages and bounds traversal (${mode})`, async () => {
	let requests = 0;
	const server = serve(() => {
		const instance = new McpServer({ name: "pages", version: "1" }, { capabilities: { resources: {} } });
		instance.server.setRequestHandler("resources/list", async request => { requests++; return { resources: [{ name: request.params?.cursor ? "second" : "first", uri: request.params?.cursor ? "fixture://second" : "fixture://first" }], ...(!request.params?.cursor || mode !== "two" ? { nextCursor: mode === "limit" ? String(requests) : "next" } : {}) }; });
		instance.server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
		return instance;
	});
	const agent = await createAgent({ ...base, mcp: { servers: { pages: { transport: "http", protocol: "2026-07-28", url: server.url } } } });
	try { expect(agent.mcp.snapshot().servers[0]!.state).toBe(mode === "limit" ? "failed" : "ready"); if (mode !== "limit") expect((await agent.mcp.listResources("pages")).map(resource => resource.name)).toEqual(["first", "second"]); expect(requests).toBe(mode === "limit" ? 64 : 2); }
	finally { await agent.dispose(); await server.close(); }
});

test("MCP large text is retained as original bytes, limits reject, and binary resource sources survive", async () => {
	const long = "原始 text\n".repeat(10000);
	const server = serve(() => {
		const instance = new McpServer({ name: "content", version: "1" });
		instance.registerResource("text", "fixture://long", {}, uri => ({ contents: [{ uri: uri.href, text: long }] }));
		instance.registerResource("binary", "fixture://binary", {}, uri => ({ contents: [{ uri: uri.href, mimeType: "application/octet-stream", blob: Buffer.from([0, 255, 1]).toString("base64") }] }));
		instance.registerResource("oversize", "fixture://oversize", {}, uri => ({ contents: [{ uri: uri.href, text: "x".repeat(17 * 1024 * 1024) }] }));
		return instance;
	});
	const agent = await createAgent({ ...base, permission: allow, mcp: { servers: { content: { transport: "http", url: server.url } } } });
	try {
		const result = await agent.mcp.readResource("content", "fixture://long"); expect(result.diagnostics).toContain("text-truncated"); expect(JSON.stringify(result.content)).toContain("Truncated");
		expect(Buffer.from((await agent.mcp.readArtifact(result.artifacts[0]!.id)).bytes).toString()).toBe(`Resource fixture://long:\n${long}`);
		const binary = await agent.mcp.readResource("content", "fixture://binary"); expect(Array.from((await agent.mcp.readArtifact(binary.artifacts[0]!.id)).bytes)).toEqual([0, 255, 1]);
		await expect(agent.mcp.readResource("content", "fixture://oversize")).rejects.toThrow("16 MiB");
	} finally { await agent.dispose(); await server.close(); }
});

test("MCP colliding normalized names route to the exact server and remote name", async () => {
	const server = serve(() => {
		const instance = new McpServer({ name: "names", version: "1" });
		for (const name of ["a.b", "a_b"]) instance.registerTool(name, {}, () => ({ content: [{ type: "text", text: name }] }));
		return instance;
	});
	const names = ["a.b", "a_b"].map(name => mcpToolName("same", name)); let requests = 0;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => ++requests === 1 ? modelResponse(names.map((name, index) => ({ id: String(index), name, arguments: {} }))) : modelResponse() });
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, storage, permission: allow, mcp: { servers: { same: { transport: "http", url: server.url } } } });
	try { expect(new Set(names).size).toBe(2); expect(names.every(name => name.length <= 64)).toBe(true); for await (const _ of agent.runTurn("call both")) {} const results = sessionMessages(await storage.load()).filter(message => message.role === "toolResult"); expect(results.map(message => message.content)).toEqual([[{ type: "text", text: "a.b" }], [{ type: "text", text: "a_b" }]]); }
	finally { await agent.dispose(); await server.close(); await model.stop(true); }
});

for (const failure of ["denied", "append", "budget"] as const) test(`MCP Prompt ${failure} never sends a partial template to a model`, async () => {
	const server = serve(mcpFixture); let requests = 0;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return modelResponse(); } });
	const storage = new MemorySessionStorage();
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: failure === "denied" ? { mode: "deny-all" } : allow,
		storage: failure === "append" ? { load: () => storage.load(), append: async () => { throw new Error("injected append failure"); } } : storage,
		...(failure === "budget" ? { contextWindow: 300, maxTokens: 50, context: { enabled: false, reserveTokens: 50 } } : {}),
		mcp: { servers: { fixture: { transport: "http", url: server.url } } },
	});
	try {
		const turn = agent.runTurn({ kind: "mcp_prompt", serverId: "fixture", name: "template", arguments: { subject: "source" }, task: "literal task" });
		try { for await (const _ of turn) {} } catch (error) { if (failure !== "append") throw error; }
		expect((await turn.result).status).toBe("error"); expect(requests).toBe(0); expect(sessionMessages(await storage.load()).filter(message => message.role === "user")).toHaveLength(0);
		if (failure === "append") { expect(() => agent.runTurn("must remain faulted")).toThrow("faulted"); expect(requests).toBe(0); }
	} finally { await agent.dispose(); await server.close(); await model.stop(true); }
});

test("MCP authorizes template arguments and expands the URI inside the tool", async () => {
	const server = serve(mcpFixture); let requests = 0; let authorized: unknown;
	const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json();
		if (++requests === 1) {
			const resource = body.tools?.find((tool: { name: string }) => tool.name === "mcp_read_resource");
			expect(resource?.input_schema?.oneOf).toHaveLength(2);
			return modelResponse([{ id: "template", name: "mcp_read_resource", arguments: { serverId: "fixture", template: "fixture://item/{id}", arguments: { id: "original" } } }]);
		}
		expect(JSON.stringify(body)).toContain("original"); return modelResponse();
	} });
	const agent = await createAgent({ ...base, baseUrl: `http://127.0.0.1:${model.port}`, permission: { hooks: [{ evaluate(call) { authorized = call.arguments; return { kind: "allow", source: "hook" }; } }] },
		mcp: { servers: { fixture: { transport: "http", url: server.url } } },
	});
	try { const turn = agent.runTurn("read template"); for await (const _ of turn) {} expect((await turn.result).status).toBe("success"); expect(authorized).toEqual({ serverId: "fixture", template: "fixture://item/{id}", arguments: { id: "original" } }); expect(requests).toBe(2); }
	finally { await agent.dispose(); await server.close(); await model.stop(true); }
});

for (const status of [401, 403, 503]) test(`MCP HTTP ${status} never falls back to legacy SSE`, async () => {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { requests.push(request.method); return new Response("private upstream failure", { status }); } });
	const agent = await createAgent({ ...base, mcp: { servers: { remote: { transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, protocol: "auto" } } } });
	try { expect(agent.mcp.snapshot().servers[0]?.state).not.toBe("ready"); expect(requests).not.toContain("GET"); expect(requests.filter(method => method === "POST")).toHaveLength(1); expect(JSON.stringify(agent.mcp.snapshot())).not.toContain("private upstream"); }
	finally { await agent.dispose(); await server.stop(true); }
});

test("MCP header authentication reaches transport but stays out of catalog and session evidence", async () => {
	const secret = "synthetic-header-token"; const headers: Array<string | null> = [];
	const handler = createMcpHandler(mcpFixture);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { headers.push(request.headers.get("authorization")); return handler.fetch(request); } });
	const agent = await createAgent({ ...base, permission: allow, mcp: { servers: { header: { transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secret}` }, auth: { type: "header" } } } } });
	try { const result = await agent.mcp.readResource("header", "fixture://data"); expect(headers.length).toBeGreaterThan(1); expect(headers.every(value => value === `Bearer ${secret}`)).toBe(true); expect(JSON.stringify({ snapshot: agent.mcp.snapshot(), result })).not.toContain(secret); }
	finally { await agent.dispose(); await server.stop(true); await handler.close(); }
});
