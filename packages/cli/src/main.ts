#!/usr/bin/env bun
import { homedir } from "node:os";
import { cwd } from "node:process";
import { createAgent, createInputCompletionSource, createPiPort, loadConfig, MemoryPermissionStore, RequestBus, resolveSecret, SessionStore, type AgentPort, type PermissionContext, type PiPortOptions } from "@myh/core";
import { builtinTools } from "@myh/tools";
import { App, scanFiles } from "@myh/tui";
import { jsonError, runHeadless } from "./headless.ts";

interface Args {
	prompt?: string;
	json: boolean;
	provider?: string;
	model?: string;
	session?: string;
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
		else if (value === "--session") args.session = requiredValue(++index, value);
		else if (value === "-h" || value === "--help") args.help = true;
		else throw new Error(`Unknown argument: ${value}`);
	}
	return args;
}

function usage(): string {
	return "myh [-p PROMPT] [--json] [--provider PROVIDER --model MODEL] [--session PATH]";
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
			const message = "Provider and model are required; set MYH_PROVIDER/MYH_MODEL or pass --provider/--model";
			if (args.json) console.log(jsonError(message));
			else console.error(message);
			return 2;
		}
		const sessionPath = args.session ?? config.sessionPath ?? `${workingDirectory}/.myh/session.jsonl`;
		const store = await SessionStore.open(sessionPath, workingDirectory);

		// Headless runs retain the bounded default; interactive users answer on their
		// own time and are cancelled explicitly by abort/exit instead.
		const requestBus = new RequestBus(args.json ? {} : { timeoutMs: null });
		const permission: PermissionContext = {
			mode: config.permissionMode,
			memory: new MemoryPermissionStore(),
			builtInAutoApprove: [{ tool: "read", argsPattern: "*", effect: "allow" }],
		};
		const apiKey = await resolveSecret(config.apiKey);
		const runner = await createAgent({
			provider,
			model,
			...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
			...(apiKey ? { apiKey } : {}),
			systemPrompt: config.systemPrompt,
			thinkingLevel: config.thinkingLevel,
			cwd: workingDirectory,
			storage: store.asStorage(),
			tools: builtinTools,
			requestBus,
			permission,
		}, portFactory);
		try {
			if (args.json) {
				return await runHeadless(runner, prompt as string, console.log, { requestBus });
			}
			const completionSource = createInputCompletionSource({
				commands: [
					{ name: "help", description: "Show commands" },
					{ name: "clear", description: "Clear the transcript" },
					{ name: "quit", description: "Exit" },
				],
				listFiles: (prefix) => scanFiles(workingDirectory, prefix),
			});
			const app = new App({
				port: runner,
				host: config.ui.host,
				requestBus,
				completionSource,
				getStatus: () => ({ provider, model }),
				cwd: workingDirectory,
				homeDir: homedir(),
				showWelcome: true,
			});
			await app.start();
			await app.waitUntilStopped();
			return 0;
		} finally {
			await runner.dispose();
		}
	} catch (error) {
		if (args.json) console.log(jsonError(error instanceof Error ? error.message : String(error), "STARTUP_ERROR"));
		else console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) process.exit(await main());
