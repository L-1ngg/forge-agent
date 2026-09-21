import { test, expect } from "bun:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createAgent } from "../src/sdk.ts";


const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "base", cwd: process.cwd() };

test("MCP modern resource subscription delivers updates and unsubscribe stops the owned stream", async () => {
	let extra = false;
    let disconnect: (() => void) | undefined;
	const handler = createMcpHandler(() => { const current = new McpServer({ name: "sub", version: "1" }, { capabilities: { resources: { subscribe: true, listChanged: true } } }); current.registerResource("value", "fixture://value", {}, uri => ({ contents: [{ uri: uri.href, text: "value" }] })); if (extra) current.registerResource("second", "fixture://second", {}, uri => ({ contents: [{ uri: uri.href, text: "second" }] })); return current; });
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const body = request.method === "POST" ? await request.clone().json() : undefined;
        const response = await handler.fetch(request);
        if (body?.method !== "subscriptions/listen" || !body.params?.notifications?.resourceSubscriptions || !response.body) return response;
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
            disconnect = () => { void reader.cancel(); };
            void (async () => { try { while (true) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); } controller.close(); } catch (error) { controller.error(error); } })();
        }, cancel() { return reader.cancel(); } });
        return new Response(stream, { status: response.status, headers: response.headers });
    } });
	const agent = await createAgent({ ...base, permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] }, mcp: { servers: { sub: { transport: "http", protocol: "2026-07-28", url: `http://127.0.0.1:${listener.port}/mcp` } } } });
	try {
        let updates = 0, active = 0; agent.mcp.subscribe(event => { if (event.type === "subscription" && event.message === "active") active++; if (event.type === "subscription" && event.uri === "fixture://value" && !event.message) updates++; });
        const wait = async (check: () => boolean) => { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) throw new Error("Subscription did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); } };
        await agent.mcp.subscribeResource("sub", "fixture://value"); handler.bus.publish({ kind: "resource_updated", uri: "fixture://value" }); await wait(() => updates === 1);
        expect(disconnect).toBeDefined(); disconnect!(); await wait(() => active === 2);
        handler.bus.publish({ kind: "resource_updated", uri: "fixture://value" }); await wait(() => updates === 2);
        const originalGeneration = agent.mcp.snapshot().servers[0]!.connectionGeneration;
        await (await agent.mcp.reconnect("sub")).applied;
        await wait(() => active === 3);
        expect(agent.mcp.snapshot().servers[0]!.connectionGeneration).toBeGreaterThan(originalGeneration);
        handler.bus.publish({ kind: "resource_updated", uri: "fixture://value" }); await wait(() => updates === 3);
        await agent.mcp.unsubscribeResource("sub", "fixture://value"); handler.bus.publish({ kind: "resource_updated", uri: "fixture://value" }); await new Promise(resolve => setTimeout(resolve, 20)); expect(updates).toBe(3);
        const generation = agent.mcp.snapshot().servers[0]!.connectionGeneration; extra = true; handler.bus.publish({ kind: "resources_list_changed" }); await wait(() => agent.mcp.snapshot().servers[0]!.resources.length === 2); expect(agent.mcp.snapshot().servers[0]!.connectionGeneration).toBe(generation); expect(agent.mcp.snapshot().revision).toBeGreaterThan(0);
    }
	finally { await agent.dispose(); await listener.stop(true); await handler.close(); }
});
