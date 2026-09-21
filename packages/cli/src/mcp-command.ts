import { tokenizeArgs } from "@forge-agent/core";
import type { AgentInput, McpController } from "@forge-agent/core/sdk";

export class McpCommandError extends Error {}
const commands = ["status", "tools", "resources", "templates", "prompts", "enable", "disable", "refresh", "reconnect", "login", "logout", "read", "subscribe", "unsubscribe", "prompt", "use-prompt", "use-resource", "artifact"];

export function isMcpCommand(input: string) { return /^\s*\/mcp(?:\s|$)/.test(input); }
export interface McpCommand { action: string; server?: string; target?: string; args: Record<string, string>; task: string; scope?: "user" | "project"; output?: string; }
export function parseMcpCommand(input: string): McpCommand {
	const raw = input.replace(/^\s*\/mcp(?:\s|$)/, "");
	// Locate the task delimiter outside quotes, preserving everything following it.
	let quote = "", escaped = false, separator = -1;
	for (let index = 0; index < raw.length; index++) { const char = raw[index]!; if (escaped) { escaped = false; continue; } if (char === "\\" && quote !== "'") { escaped = true; continue; } if (quote) { if (char === quote) quote = ""; continue; } if (char === "'" || char === '"') { quote = char; continue; } if (raw.slice(index, index + 2) === "--" && (index === 0 || /\s/.test(raw[index - 1]!)) && (index + 2 === raw.length || /\s/.test(raw[index + 2]!))) { separator = index; break; } }
	if (quote) throw new McpCommandError("Unclosed MCP command quote");
	const tokens = tokenizeArgs(separator < 0 ? raw : raw.slice(0, separator));
	const task = separator < 0 ? "" : raw.slice(separator + 2).replace(/^[ \t\r\n]/, "");
	let output: string | undefined;
	let args: Record<string, string> = {}, scope: "user" | "project" | undefined; const positional: string[] = [];
	for (let index = 0; index < tokens.length; index++) { const token = tokens[index]!;
		if (token === "--args") { let value: unknown; try { value = JSON.parse(tokens[++index] ?? ""); } catch { throw new McpCommandError("--args requires valid JSON"); } if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(item => typeof item !== "string")) throw new McpCommandError("MCP prompt arguments must be a JSON object of strings"); args = value as Record<string, string>; }
		else if (token === "--scope") { const value = tokens[++index]; if (value !== "user" && value !== "project") throw new McpCommandError("--scope must be user or project"); scope = value; }
		else if (token === "--output") { output = tokens[++index]; if (!output) throw new McpCommandError("--output requires a path"); }
		else if (token.startsWith("--")) throw new McpCommandError(`Unknown MCP option ${token}`); else positional.push(token);
	}
	if (positional.length > 3) throw new McpCommandError("Too many MCP command arguments");
	const action = positional[0] ?? "status";
    if (!commands.includes(action)) throw new McpCommandError(`MCP commands: ${commands.join(", ")}`);
    if (!["status", "refresh"].includes(action) && !positional[1]) throw new McpCommandError("MCP server or artifact ID is required");
    if (["read", "subscribe", "unsubscribe", "prompt", "use-prompt", "use-resource"].includes(action) && !positional[2]) throw new McpCommandError("MCP resource URI or prompt name is required");
    if (output && action !== "artifact") throw new McpCommandError("--output is only available for artifact");
    return { action, ...(output ? { output } : {}), ...(positional[1] ? { server: positional[1] } : {}), ...(positional[2] ? { target: positional[2] } : {}), args, task, ...(scope ? { scope } : {}) };
}
export function mcpInput(input: string): AgentInput {
	if (!isMcpCommand(input)) return input; const command = parseMcpCommand(input);
	if (command.action === "use-prompt" && command.server && command.target) return { kind: "mcp_prompt", serverId: command.server, name: command.target, arguments: command.args, task: command.task };
	if (command.action === "use-resource" && command.server && command.target) return { kind: "mcp_resource", serverId: command.server, uri: command.target, task: command.task };
	throw new McpCommandError("Usage: /mcp use-prompt <server> <name> --args '<JSON>' -- <task>, or /mcp use-resource <server> <uri> -- <task>");
}
export async function mcpCommand(controller: McpController, input: string, report: (value: object) => void, options: { signal?: AbortSignal; credentialStore?: "system" | "linux-keyutils" } = {}): Promise<void> {
	const command = parseMcpCommand(input); const server = () => { if (!command.server) throw new McpCommandError("MCP server ID is required"); return command.server; }; const target = () => { if (!command.target) throw new McpCommandError("MCP resource URI or prompt name is required"); return command.target; };
	let result: unknown;
	switch (command.action) {
		case "status": result = { ...controller.snapshot(), ...(command.server ? { servers: controller.snapshot().servers.filter(item => item.serverId === command.server) } : {}), ...(options.credentialStore ? { credentialStore: options.credentialStore, persistence: options.credentialStore === "linux-keyutils" ? "Saved in this Linux/WSL instance; system restart may require login again" : "System credential store" } : {}) }; break;
		case "tools": result = controller.snapshot().servers.find(item => item.serverId === server())?.tools; break;
		case "resources": result = await controller.listResources(server()); break;
		case "templates": result = await controller.listResourceTemplates(server()); break;
		case "prompts": result = await controller.listPrompts(server()); break;
		case "read": result = await controller.readResource(server(), target()); break;
		case "prompt": result = await controller.getPrompt(server(), target(), command.args); break;
		case "subscribe": await controller.subscribeResource(server(), target()); result = { status: "subscribed" }; break;
		case "unsubscribe": await controller.unsubscribeResource(server(), target()); result = { status: "unsubscribed" }; break;
		case "artifact": { const artifact = await controller.readArtifact(server(), options);
            if (command.output) { const { writeFile } = await import("node:fs/promises"); await writeFile(command.output, artifact.bytes, { flag: "wx", mode: 0o600 }); result = { metadata: artifact.metadata, path: command.output }; }
            else result = { metadata: artifact.metadata, encoding: "base64", data: Buffer.from(artifact.bytes).toString("base64") }; break; }
		case "login": result = await controller.login(server(), options); break;
		case "logout": result = await controller.logout(server(), options); break;
		case "enable": case "disable": case "refresh": case "reconnect": {
			const receipt = command.action === "refresh" ? await controller.refresh(command.server) : command.action === "reconnect" ? await controller.reconnect(server()) : await controller.setEnabled(server(), command.action === "enable");
			report({ type: "mcp", phase: "accepted", revision: receipt.revision }); result = { phase: (await receipt.applied).status, revision: receipt.revision }; break;
		}
		default: throw new McpCommandError("MCP commands: status, tools, resources, templates, prompts, enable, disable, refresh, reconnect, login, logout, read, subscribe, unsubscribe, prompt, use-prompt, use-resource, artifact");
	}
	report({ type: "mcp", command: command.action, result });
}

/** Persist only the selected definition; refuse an observed concurrent edit. */
export async function persistMcpEnabled(cwd: string, config: import("@forge-agent/core").HarnessConfig, command: McpCommand): Promise<void> {
	if (!command.scope || !command.server) throw new McpCommandError("Persistent enable/disable requires <server> --scope user|project");
	const { readFile, mkdir, writeFile, rename, unlink } = await import("node:fs/promises");
	const { join, dirname } = await import("node:path"); const { homedir } = await import("node:os"); const { randomUUID } = await import("node:crypto");
	const target = command.scope === "project" ? join(cwd, ".forge-agent", "config.json") : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "forge-agent", "config.json");
	const read = async () => { try { return await readFile(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } };
	const before = await read(); const json = JSON.parse(before || "{}");
	const effective = config.mcp?.servers[command.server]; if (!effective) throw new McpCommandError("Unknown MCP server");
	let definition = json.mcp?.servers?.[command.server];
	if (!definition) { if (!effective.source) throw new McpCommandError("MCP server source is unavailable"); const source = JSON.parse(await readFile(effective.source, "utf8")); definition = source.mcp?.servers?.[command.server]; if (!definition) throw new McpCommandError("MCP configuration changed; reload before saving"); definition = { ...definition, ...(effective.transport === "stdio" ? { cwd: effective.cwd } : {}) }; }
	json.mcp ??= {}; json.mcp.servers ??= {}; json.mcp.servers[command.server] = { ...definition, enabled: command.action === "enable" };
	await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`;
	try { await writeFile(temporary, JSON.stringify(json, null, 2) + "\n", { flag: "wx", mode: 0o600 }); if (await read() !== before) throw new McpCommandError("MCP configuration changed; reload before saving"); await rename(temporary, target); }
	finally { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export async function mcpCompletions(controller: McpController, input: string, signal?: AbortSignal): Promise<import("@forge-agent/protocol").InputCompletionSuggestions | null> {
	if (!/^\s*\/mcp\s/.test(input)) return null;
	const args = input.replace(/^\s*\/mcp\s+/, ""); const tokens = tokenizeArgs(args); const prefix = /\s$/.test(args) ? "" : tokens.pop() ?? "";
	let values: string[] = [];
	if (!tokens.length) values = ["status", "tools", "resources", "templates", "prompts", "enable", "disable", "refresh", "reconnect", "login", "logout", "read", "subscribe", "unsubscribe", "prompt", "use-prompt", "use-resource", "artifact"];
	else if (tokens.length === 1) values = controller.snapshot().servers.map(server => server.serverId);
	else if (tokens.length === 2) { const server = controller.snapshot().servers.find(server => server.serverId === tokens[1]); values = ["prompt", "use-prompt"].includes(tokens[0]!) ? server?.prompts.map(prompt => prompt.name) ?? [] : server?.resources.map(resource => resource.uri) ?? []; }
	const argument = /(?:prompt|use-prompt)\s+(\S+)\s+(\S+)\s+--args\s+'?\{[\s\S]*"([^"\\]+)"\s*:\s*"([^"\\]*)$/.exec(args);
	if (argument) { try { values = await controller.complete(argument[1]!, { type: "ref/prompt", name: argument[2]! }, { name: argument[3]!, value: argument[4]! }, undefined, signal ? { signal } : {}); return { prefix: argument[4]!, items: values.map(value => ({ value, label: value })) }; } catch { return null; } }
	return { prefix, items: values.filter(value => value.startsWith(prefix)).map(value => ({ value: value + " ", label: value })) };
}
