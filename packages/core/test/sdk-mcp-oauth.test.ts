import { test, expect } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createAgent, MemoryMcpCredentialStore, type McpInteraction } from "../src/sdk.ts";
import { mcpFixture } from "./helpers/mcp-server.ts";
const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "base", cwd: process.cwd() };
function oauthFixture() {
	const handler = createMcpHandler(mcpFixture); let exchanges = 0, resourceCalls = 0; let expectedToken = "initial"; let token = "initial";
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const url = new URL(request.url), origin = url.origin;
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
		if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
		if (url.pathname === "/register") return Response.json({ ...await request.json(), client_id: "fixture-client" }, { status: 201 });
		if (url.pathname === "/token") { exchanges++; const params = new URLSearchParams(await request.text()); if (params.get("grant_type") === "authorization_code" && (!params.get("code_verifier") || params.get("code") !== "fixture-code")) return Response.json({ error: "invalid_grant" }, { status: 400 }); token = expectedToken; return Response.json({ access_token: token, token_type: "Bearer", refresh_token: `refresh-${exchanges}`, expires_in: 3600, scope: "read" }); }
		if (url.pathname === "/mcp") { if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } }); resourceCalls++; return handler.fetch(request); }
		return new Response("not found", { status: 404 });
	} });
	return { url: `http://127.0.0.1:${listener.port}/mcp`, issuer: `http://127.0.0.1:${listener.port}`, counts: () => ({ exchanges, resourceCalls }), rotate: () => { expectedToken = "rotated"; }, async close() { await listener.stop(true); await handler.close(); } };
}
test("MCP OAuth public lifecycle: auth-required startup, verified callback, persistence, refresh rotation, logout", async () => {
	const fixture = oauthFixture(); const credentials = new MemoryMcpCredentialStore(); let opened = 0, closed = 0;
	const interaction: McpInteraction = { async beginAuthorization() { return { redirectUri: "http://127.0.0.1:45678/callback", async authorize(url) { opened++; expect(url.searchParams.get("code_challenge_method")).toBe("S256"); return new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code", iss: fixture.issuer }); }, close() { closed++; } }; } };
	const options = { ...base, mcp: { credentials, interaction, servers: { fixture: { transport: "http" as const, url: fixture.url, auth: { type: "oauth" as const, scopes: ["read"] } } } } };
	let agent = await createAgent(options);
	try {
		expect(agent.mcp.snapshot().servers[0]?.state).toBe("auth-required"); expect(opened).toBe(0);
		expect((await agent.mcp.login("fixture")).status).toBe("authenticated"); expect(opened).toBe(1); expect(closed).toBe(1); expect(fixture.counts().exchanges).toBe(1);
		await agent.dispose(); agent = await createAgent(options); expect(agent.mcp.snapshot().servers[0]?.state).toBe("ready"); expect(opened).toBe(1);
		fixture.rotate(); await (await agent.mcp.refresh()).applied; expect(fixture.counts().exchanges).toBe(2);
		expect((await agent.mcp.logout("fixture")).status).toBe("logged-out");
	} finally { await agent.dispose(); await fixture.close(); }
});
for (const failure of ["state", "issuer", "denied"] as const) test(`MCP OAuth rejects ${failure} callback and closes interaction`, async () => {
	const fixture = oauthFixture(); let closed = false;
	const interaction: McpInteraction = { async beginAuthorization() { return { redirectUri: "http://127.0.0.1:45678/callback", async authorize(url) { return new URLSearchParams({ state: failure === "state" ? "wrong" : url.searchParams.get("state")!, ...(failure === "denied" ? { error: "access_denied" } : { code: "fixture-code", iss: failure === "issuer" ? "https://wrong.invalid" : fixture.issuer }) }); }, close() { closed = true; } }; } };
	const agent = await createAgent({ ...base, mcp: { interaction, servers: { fixture: { transport: "http", url: fixture.url, auth: { type: "oauth" } } } } });
	try { await expect(agent.mcp.login("fixture")).rejects.toThrow(); expect(closed).toBe(true); expect(fixture.counts().exchanges).toBe(0); expect(agent.mcp.snapshot().servers[0]?.state).toBe("auth-required"); }
	finally { await agent.dispose(); await fixture.close(); }
});

test("MCP canceled native credential write retains its lock until real settlement; logout then clears it", async () => {
	const fixture = oauthFixture();
	let unlock!: () => void, started!: () => void;
	const pending = new Promise<void>(resolve => { unlock = resolve; }); const writing = new Promise<void>(resolve => { started = resolve; });
	class SlowStore extends MemoryMcpCredentialStore {
		block = true;
		override async write(key: string, record: import("../src/sdk.ts").McpCredentialRecord) { if (record.tokens && this.block) { this.block = false; started(); await pending; } await super.write(key, record); }
	}
	const store = new SlowStore();
	const interaction: McpInteraction = { async beginAuthorization() { return { redirectUri: "http://127.0.0.1:45678/callback", async authorize(url) { return new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code", iss: fixture.issuer }); }, close() {} }; } };
	const options = { ...base, mcp: { credentials: store, interaction, servers: { fixture: { transport: "http" as const, url: fixture.url, auth: { type: "oauth" as const } } } } };
	const agent = await createAgent(options); const signal = new AbortController();
	try { const login = agent.mcp.login("fixture", { signal: signal.signal }); await writing; signal.abort(); await expect(login).rejects.toThrow("outcome"); let loggedOut = false; const logout = agent.mcp.logout("fixture").then(result => { loggedOut = true; return result; }); await new Promise(resolve => setTimeout(resolve, 10)); expect(loggedOut).toBe(false); unlock(); expect((await logout).status).toBe("logged-out"); const other = await createAgent(options); try { expect(other.mcp.snapshot().servers[0]?.state).toBe("auth-required"); } finally { await other.dispose(); } }
	finally { unlock(); await agent.dispose(); await fixture.close(); }
});

test("MCP SDK interaction ignoring cancellation settles caller and closes callback adapter", async () => {
	const fixture = oauthFixture(); let began!: () => void, closed = false;
	const ready = new Promise<void>(resolve => { began = resolve; });
	const interaction: McpInteraction = { async beginAuthorization() { return { redirectUri: "http://127.0.0.1:45678/callback", authorize() { began(); return new Promise(() => {}); }, close() { closed = true; } }; } };
	const agent = await createAgent({ ...base, mcp: { interaction, servers: { fixture: { transport: "http", url: fixture.url, auth: { type: "oauth" } } } } });
	try { const signal = new AbortController(); const login = agent.mcp.login("fixture", { signal: signal.signal }); await ready; signal.abort(); await expect(login).rejects.toThrow(); await agent.dispose(); expect(closed).toBe(true); }
	finally { await agent.dispose(); await fixture.close(); }
});
