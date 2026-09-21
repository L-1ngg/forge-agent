#!/usr/bin/env bun
import { McpCommandError, mcpCommand, mcpInput, isMcpCommand, parseMcpCommand, persistMcpEnabled, mcpCompletions } from "./mcp-command.ts";
import { ProjectMcpArtifactStore, SystemMcpCredentialStore, openMcpUrl, browserMcpInteraction } from "./mcp-host.ts";
import { McpManager, RequestBus } from "@forge-agent/core";
import { McpError } from "@forge-agent/core/sdk";
import { cliSkills, skillInput, isSkillsCommand, skillsCommand, skillsText } from "./skills-command.ts";
import { homedir } from "node:os";
import { cwd } from "node:process";
import { createInputCompletionSource, loadConfig, resolveSecret } from "@forge-agent/core";
import { builtinTools } from "@forge-agent/tools";
import { App, scanFiles } from "@forge-agent/tui";
import { SessionHost, projectRoot } from "./session-host.ts";
import { jsonError, runHeadless, headlessRequestDecision } from "./headless.ts";
import { createMemoryHost } from "./memory-host.ts";
import { MemoryManager } from "./memory-command.ts";
import type { MemoryOptions } from "@forge-agent/core/sdk";

interface Args {
	noMcp?: boolean;
	mcpCommand?: string;
	noSkills?: boolean;
	memoryCommand?: string;
	prompt?: string;
	json: boolean;
	provider?: string;
	model?: string;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { json: false, help: false };
	const requiredValue = (index: number, flag: string): string => {
		const value = argv[index];
		if (!value) throw new Error(`${flag} requires a value`);
		return value;
	};
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "-p" || value === "--prompt") args.prompt = requiredValue(++index, value);
		else if (value === "--no-mcp") args.noMcp = true;
		else if (value === "--mcp") args.mcpCommand = requiredValue(++index, value);
		else if (value === "--no-skills") args.noSkills = true;
		else if (value === "--json") args.json = true;
		else if (value === "--provider") args.provider = requiredValue(++index, value);
		else if (value === "--model") args.model = requiredValue(++index, value);
		else if (value === "--memory") args.memoryCommand = requiredValue(++index, value);
		else if (value === "-h" || value === "--help") args.help = true;
		else throw new Error(`Unknown argument: ${value}`);
	}
	return args;
}

function usage(): string {
	return "forge-agent [-p PROMPT] [--json] [--provider PROVIDER --model MODEL] [--memory 'COMMAND'] [--no-skills] [--mcp 'COMMAND'] [--no-mcp]";
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		if (argv.includes("--json")) console.log(jsonError(error instanceof Error ? error.message : String(error), "INVALID_ARGUMENT"));
		else console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}

	try {
		const workingDirectory = cwd();
		const config = await loadConfig({ cwd: workingDirectory });
		const selectedMcp = args.noMcp ? false : config.mcp ? { enabled: config.mcp.enabled ?? true, servers: config.mcp.servers, credentials: new SystemMcpCredentialStore(config.mcp.credentialStore) } : false;
        if (args.mcpCommand && !parseMcpCommand(args.mcpCommand).action.startsWith("use-")) {
            const command = parseMcpCommand(args.mcpCommand);
            if (["enable", "disable"].includes(command.action)) { await persistMcpEnabled(workingDirectory, config, command); console.log(JSON.stringify({ type: "mcp", status: "saved", scope: command.scope })); return 0; }
            const bus = new RequestBus(); const { join } = await import("node:path"); const managementMcp = selectedMcp ? { ...selectedMcp, artifacts: new ProjectMcpArtifactStore(join(await projectRoot(workingDirectory), ".forge-agent", "artifacts")), ...(!args.json ? { interaction: browserMcpInteraction(bus) } : {}) } : false;
            const manager = new McpManager(managementMcp, { cwd: workingDirectory, permission: { mode: config.permissionMode }, requestBus: bus });
            const canceled = new AbortController();
            const interrupt = () => { canceled.abort(); bus.close(); void manager.dispose().catch(() => {}); };
            process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
            const responder = (async () => {
                for await (const request of bus.requests()) {
                    if (!args.json && request.kind === "oauth") console.log(`MCP authorization: ${request.payload.authorizationUrl}`);
                    else if (!args.json && process.stdin.isTTY && request.kind === "permission") {
                        const { createInterface } = await import("node:readline/promises");
                        const terminal = createInterface({ input: process.stdin, output: process.stderr });
                        try { const answer = await terminal.question(`Allow ${request.payload.toolCall.name} ${JSON.stringify(request.payload.toolCall.arguments)}? [y/N] `, { signal: canceled.signal }); bus.respond({ type: "response", id: request.id, result: answer.toLowerCase() === "y" ? { decision: "allow_once" } : { decision: "deny" } }); }
                        catch { bus.respond(headlessRequestDecision(request).response); }
                        finally { terminal.close(); }
                    } else bus.respond(headlessRequestDecision(request).response);
                }
            })();
            let revision = 0; let desired = selectedMcp ? { enabled: selectedMcp.enabled, servers: selectedMcp.servers } : false as const;
            let queue = Promise.resolve();
            manager.bind(patch => { const operation = queue.then(async () => { if (patch.mcp !== undefined) desired = patch.mcp === false ? false : { enabled: patch.mcp.enabled ?? true, servers: patch.mcp.servers }; const candidate = await manager.prepare(desired, []); candidate.commit(++revision); return { accepted: true as const, revision, applied: Promise.resolve({ status: "applied" as const, revision }) }; }); queue = operation.then(() => {}, () => {}); return operation; });
            try { const candidate = await manager.prepare(desired, []); candidate.commit(0); await mcpCommand(manager, args.mcpCommand, value => console.log(JSON.stringify(value, null, args.json ? undefined : 2)), { signal: canceled.signal, credentialStore: config.mcp?.credentialStore ?? "system" }); return 0; }
            finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); bus.close(); await manager.dispose(); await responder; }
        }
        const prepareInput = (input: string) => isMcpCommand(input) ? mcpInput(input) : skillInput(input);
        const memoryHost = await createMemoryHost(workingDirectory);
		const memory: MemoryOptions = { store: memoryHost.memory, autoUpdate: config.memory?.autoUpdate ?? true, injection: config.memory?.injection ?? true };
		if (args.memoryCommand) {
			const result = await new MemoryManager(memory).execute(args.memoryCommand);
			console.log(result.text); return 0;
		}
		const prompt = args.mcpCommand ? `/mcp ${args.mcpCommand}` : args.prompt;
		if (args.json && !prompt) {
			console.log(jsonError("-p/--prompt is required with --json", "INVALID_ARGUMENT"));
			return 2;
		}
		const provider = args.provider ?? config.provider;
		const model = args.model ?? config.model;
		if (!provider || !model) {
			const message = "Provider and model are required; set FORGE_AGENT_PROVIDER/FORGE_AGENT_MODEL or pass --provider/--model";
			if (args.json) console.log(jsonError(message));
			else console.error(message);
			return 2;
		}
		const apiKey = await resolveSecret(config.apiKey);
		const sessions = await SessionHost.create({
			provider,
			model,
			...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
			...(apiKey ? { apiKey } : {}),
			systemPrompt: config.systemPrompt,
			thinkingLevel: config.thinkingLevel,
			...(config.context ? { context: config.context } : {}),
			...(config.retry ? { retry: config.retry } : {}),
			...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
			...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
			cwd: workingDirectory,
			mcp: selectedMcp,
			mcpCredentialStore: config.mcp?.credentialStore ?? "system",
			mcpInteractive: !args.json,
			skills: await cliSkills(workingDirectory, config.skills, args.noSkills ?? false),
			memory,
			tools: builtinTools,
			requestTimeoutMs: args.json ? 30_000 : null,
			permission: { mode: config.permissionMode, builtInAutoApprove: [{ tool: "read", argsPattern: "*", effect: "allow" }, ...["load_skill", "read_memory", "search_memory", ...(config.permissionMode === "deny-all" ? [] : ["write_memory", "delete_memory"])].map(tool => ({ tool, argsPattern: "*", effect: "allow" as const }))] },
		});
		try {
			const memoryManager = new MemoryManager(memory, id => sessions.memoryImport(id), () => sessions.current.port.getMemoryBudget?.());
			if (prompt && isSkillsCommand(prompt)) {
				await skillsCommand(sessions.current.port, prompt, value => console.log(args.json ? JSON.stringify(value) : skillsText(value))); return 0;
			}
			if (args.json) {
				return await runHeadless(sessions.current.port, prepareInput(prompt as string), console.log, { requestBus: sessions.current.requestBus });
			}
			const completionSource = createInputCompletionSource({
				completeInput: (input, signal) => mcpCompletions(sessions.current.port.mcp, input, signal),
				listSkills: () => sessions.current.port.getSkills().entries.filter(entry => entry.status === "available").map(entry => ({ name: entry.name!, description: entry.description! })),
				commands: [
					{ name: "help", description: "Show commands" },
					{ name: "clear", description: "Clear display; keep context" },
					{ name: "new", description: "Start a new conversation" },
					{ name: "resume", description: "Resume a project conversation" },
					{ name: "compact", description: "Compact context" },
					{ name: "memory", description: "Manage persistent memory" },
					{ name: "mcp", description: "Manage MCP servers, resources, prompts and authentication" },
					{ name: "skills", description: "List skills; reload to refresh" },
					{ name: "skill", description: "Select a skill explicitly" },
					{ name: "quit", description: "Exit" },
				],
				listFiles: (prefix) => scanFiles(workingDirectory, prefix),
			});
			const app = new App({
				prepareInput,
				openExternal: openMcpUrl,
				mcpCommand: async (input, report) => { const command = parseMcpCommand(input); if (command.scope && ["enable", "disable"].includes(command.action)) await persistMcpEnabled(workingDirectory, config, command); await mcpCommand(sessions.current.port.mcp, input, value => report(JSON.stringify(value, null, 2)), { credentialStore: config.mcp?.credentialStore ?? "system" }); },
				skillsCommand: (input, report) => skillsCommand(sessions.current.port, input, value => report(skillsText(value))),
				port: sessions.current.port,
				memoryCommand: input => memoryManager.execute(input),
				sessions,
				host: config.ui.host,
				requestBus: sessions.current.requestBus,
				completionSource,
				getStatus: () => ({ provider, model }),
				cwd: workingDirectory,
				homeDir: homedir(),
				showWelcome: true,
				history: sessions.current.history,
			});
			await app.start();
			await app.waitUntilStopped();
			return 0;
		} finally {
			await sessions.dispose();
		}
	} catch (error) {
		if (args.json) console.log(jsonError(error instanceof Error ? error.message : String(error), error instanceof McpCommandError ? "INVALID_ARGUMENT" : "STARTUP_ERROR"));
		else console.error(error instanceof Error ? error.message : String(error));
		return error instanceof McpCommandError ? 2 : error instanceof McpError && error.code === "auth-required" ? 24 : 1;
	}
}

if (import.meta.main) process.exit(await main());
