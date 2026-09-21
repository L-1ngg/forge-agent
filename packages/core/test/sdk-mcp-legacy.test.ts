import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAgent } from "../src/sdk.ts";

test("real v1.30 SDK server interoperates over explicit legacy SSE and closes ports", async () => {
	let subscribed = false;
	const servers: McpServer[] = []; const transports = new Map<string, SSEServerTransport>();
	const http = createServer(async (request, response) => {
		const url = new URL(request.url!, "http://localhost");
		if (url.pathname === "/sse") {
			const transport = new SSEServerTransport("/messages", response); const server = new McpServer({ name: "v1-fixture", version: "1.30.0" }, { capabilities: { resources: { subscribe: true } } });
			server.registerResource("legacy", "legacy://data", {}, uri => ({ contents: [{ uri: uri.href, text: "V1 RESOURCE" }] }));
			server.server.setRequestHandler(SubscribeRequestSchema, async () => { subscribed = true; return {}; }); server.server.setRequestHandler(UnsubscribeRequestSchema, async () => { subscribed = false; return {}; });
            transports.set(transport.sessionId, transport); servers.push(server); await server.connect(transport);
		} else if (url.pathname === "/messages") { const transport = transports.get(url.searchParams.get("sessionId")!); if (transport) await transport.handlePostMessage(request, response); else { response.writeHead(404); response.end(); } }
		else { response.writeHead(404); response.end(); }
	});
	await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve)); const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
	const agent = await createAgent({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "base", cwd: process.cwd(), permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] }, mcp: { servers: { legacy: { transport: "sse", url: `http://127.0.0.1:${address.port}/sse` } } } });
	try { expect(agent.mcp.snapshot().servers[0]?.state).toBe("ready"); expect(await agent.mcp.listResources("legacy")).toHaveLength(1); expect(JSON.stringify(await agent.mcp.readResource("legacy", "legacy://data"))).toContain("V1 RESOURCE");
        let updates = 0; agent.mcp.subscribe(event => { if (event.type === "subscription" && !event.message) updates++; });
        await agent.mcp.subscribeResource("legacy", "legacy://data"); expect(subscribed).toBe(true);
        await servers[0]!.server.sendResourceUpdated({ uri: "legacy://data" });
        const deadline = Date.now() + 1000; while (!updates && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); expect(updates).toBe(1);
        await agent.mcp.unsubscribeResource("legacy", "legacy://data"); expect(subscribed).toBe(false);
        await servers[0]!.server.sendResourceUpdated({ uri: "legacy://data" }); await new Promise(resolve => setTimeout(resolve, 20)); expect(updates).toBe(1);
    }
	finally { await agent.dispose(); await Promise.all(servers.map(server => server.close())); await new Promise<void>((resolve, reject) => { http.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()); http.closeAllConnections(); }); }
});
