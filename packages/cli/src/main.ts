#!/usr/bin/env bun
import { homedir } from "node:os";
import { cwd } from "node:process";
import { createInputCompletionSource, createPiPort, loadConfig, resolveSecret, type AgentPort, type PiPortOptions } from "@forge-agent/core";
import { builtinTools } from "@forge-agent/tools";
import { App, scanFiles } from "@forge-agent/tui";
import { SessionHost } from "./session-host.ts";
import { jsonError, runHeadless } from "./headless.ts";

interface Args {
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
		else if (value === "--json") args.json = true;
		else if (value === "--provider") args.provider = requiredValue(++index, value);
		else if (value === "--model") args.model = requiredValue(++index, value);
		else if (value === "-h" || value === "--help") args.help = true;
		else throw new Error(`Unknown argument: ${value}`);
	}
	return args;
}

function usage(): string {
	return "forge-agent [-p PROMPT] [--json] [--provider PROVIDER --model MODEL]";
}

type PortFactory = (options: PiPortOptions) => Promise<AgentPort>;

export async function main(argv = Bun.argv.slice(2), portFactory: PortFactory = createPiPort): Promise<number> {
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
		const prompt = args.prompt;
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
			tools: builtinTools,
			requestTimeoutMs: args.json ? 30_000 : null,
			permission: { mode: config.permissionMode, builtInAutoApprove: [{ tool: "read", argsPattern: "*", effect: "allow" }] },
		}, portFactory);
		try {
			if (args.json) {
				return await runHeadless(sessions.current.port, prompt as string, console.log, { requestBus: sessions.current.requestBus });
			}
			const completionSource = createInputCompletionSource({
				commands: [
					{ name: "help", description: "Show commands" },
					{ name: "clear", description: "Clear display; keep context" },
					{ name: "new", description: "Start a new conversation" },
					{ name: "resume", description: "Resume a project conversation" },
					{ name: "compact", description: "Compact context" },
					{ name: "quit", description: "Exit" },
				],
				listFiles: (prefix) => scanFiles(workingDirectory, prefix),
			});
			const app = new App({
				port: sessions.current.port,
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
		if (args.json) console.log(jsonError(error instanceof Error ? error.message : String(error), "STARTUP_ERROR"));
		else console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) process.exit(await main());
