import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { McpError, type McpConfiguration, type McpServerConfiguration } from "./types.ts";

const serverKeys = new Set(["transport", "enabled", "command", "args", "cwd", "env", "url", "headers", "protocol", "auth", "tools", "timeouts", "source"]);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
export function normalizeMcpConfiguration(input: McpConfiguration | false | undefined, cwd: string, env: NodeJS.ProcessEnv = process.env, expandEnvironment = true): McpConfiguration {
	if (!input || input.enabled === false) return { enabled: false, servers: {} };
	if (!object(input) || !object(input.servers) || Object.keys(input).some(key => !["enabled", "servers"].includes(key)) || (input.enabled !== undefined && typeof input.enabled !== "boolean")) throw new McpError("invalid-config", "Invalid MCP configuration");
	const servers: Record<string, McpServerConfiguration> = {};
	for (const [id, raw] of Object.entries(input.servers)) {
		const fail = (field: string): never => { throw new McpError("invalid-config", `MCP ${id}: invalid ${field}`); };
		if (!/^[A-Za-z0-9_-]{1,48}$/.test(id) || !object(raw)) fail("server ID or definition");
		for (const key of Object.keys(raw)) if (!serverKeys.has(key)) fail(`field ${key}`);
		const server = structuredClone(raw);
		if (!["stdio", "http", "sse"].includes(server.transport)) fail("transport");
		if (server.enabled !== undefined && typeof server.enabled !== "boolean") fail("enabled");
		if (server.protocol !== undefined && !["legacy", "auto", "2026-07-28"].includes(server.protocol)) fail("protocol");
		server.protocol ??= server.transport === "http" ? "auto" : "legacy";
		if (server.transport === "sse" && server.protocol !== "legacy") fail("SSE protocol");
		if (server.transport === "stdio") {
			if (typeof server.command !== "string" || !server.command || server.url || server.headers || server.auth) fail("stdio options");
			if (server.args !== undefined && !strings(server.args)) fail("args");
			if (server.cwd !== undefined && typeof server.cwd !== "string") fail("cwd");
			server.cwd = resolve(cwd, server.cwd ?? ".");
		} else {
			if (typeof server.url !== "string" || server.command || server.args || server.cwd || server.env) fail("remote options");
			try { const url = new URL(server.url!); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("url"); } catch { fail("url"); }
		}
		for (const field of ["env", "headers"] as const) {
			const values = server[field]; if (values === undefined) continue;
			if (!object(values)) fail(field);
			for (const [key, value] of Object.entries(values)) {
				if (typeof value !== "string" || value.startsWith("!")) fail(field);
				if (!expandEnvironment) continue;
				values[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a: string, b: string) => {
					const name = a ?? b; if (env[name] === undefined) throw new McpError("missing-env", `MCP ${id}: missing environment variable ${name}`); return env[name]!;
				});
			}
		}
		if (server.auth) {
			if (!object(server.auth) || Object.keys(server.auth).some(key => !["type", "profile", "scopes"].includes(key)) || !["none", "header", "oauth"].includes(server.auth.type)) fail("auth");
			if (server.auth.profile !== undefined && typeof server.auth.profile !== "string") fail("auth.profile");
			if (server.auth.scopes !== undefined && !strings(server.auth.scopes)) fail("auth.scopes");
			if (server.auth.type === "oauth" && Object.keys(server.headers ?? {}).some(key => key.toLowerCase() === "authorization")) fail("OAuth/Authorization conflict");
		}
		if (server.tools && (!object(server.tools) || Object.keys(server.tools).some(key => !["include", "exclude"].includes(key)) || Object.values(server.tools).some(value => !strings(value)))) fail("tools");
		if (server.timeouts) {
			if (!object(server.timeouts) || Object.entries(server.timeouts).some(([key, value]) => !["connect", "request", "tool", "total", "interaction", "cleanup"].includes(key) || typeof value !== "number" || !Number.isFinite(value) || value <= 0)) fail("timeouts");
			if ((server.timeouts.total ?? 300000) < (server.timeouts.tool ?? 60000)) fail("total timeout");
		}
		servers[id] = server;
	}
	return { enabled: true, servers };
}
export function mcpToolName(serverId: string, name: string): string {
	const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 22);
	return `mcp_${clean(serverId)}_${clean(name)}_${createHash("sha256").update(`${serverId}\0${name}`).digest("hex").slice(0, 12)}`;
}
export function connectionIdentity(server: McpServerConfiguration): string {
	const { tools: _tools, enabled: _enabled, source: _source, ...identity } = server;
	return JSON.stringify(identity);
}
