import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode } from "./permission/decide.ts";

export type TuiHostMode = "main" | "alt";

export interface HarnessUiConfig {
	host: TuiHostMode;
}

export interface HarnessConfig {
	provider?: string;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	systemPrompt: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	permissionMode: PermissionMode;
	ui: HarnessUiConfig;
	sessionPath?: string;
}

export interface LoadConfigOptions {
	cwd: string;
	home?: string;
	env?: Record<string, string | undefined>;
}

const defaults: HarnessConfig = {
	systemPrompt: "You are a coding assistant. Work carefully in the current directory and keep responses concise.",
	thinkingLevel: "medium",
	permissionMode: "default",
	ui: { host: "main" },
};

async function readConfig(path: string): Promise<Partial<HarnessConfig>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Partial<HarnessConfig>;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
		throw new Error(`Unable to read config ${path}`, { cause: error });
	}
}

export async function loadConfig(options: LoadConfigOptions): Promise<HarnessConfig> {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const globalPath = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "myh", "config.json");
	const projectPath = join(options.cwd, ".myh", "config.json");
	const globalConfig = await readConfig(globalPath);
	const projectConfig = await readConfig(projectPath);
	const mergedUi = {
		...defaults.ui,
		...(globalConfig.ui ?? {}),
		...(projectConfig.ui ?? {}),
	};
	if (mergedUi.host !== "main" && mergedUi.host !== "alt") mergedUi.host = "main";
	return {
		...defaults,
		...globalConfig,
		...projectConfig,
		ui: mergedUi,
		...(env.MYH_PROVIDER ? { provider: env.MYH_PROVIDER } : {}),
		...(env.MYH_MODEL ? { model: env.MYH_MODEL } : {}),
		...(env.MYH_API_KEY ? { apiKey: env.MYH_API_KEY } : {}),
	};
}

export async function resolveSecret(value: string | undefined, env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
	if (value === undefined) return undefined;
	if (value.startsWith("!")) {
		const command = value.slice(1).trim();
		if (!command) throw new Error("Secret command must not be empty");
		const child = Bun.spawn([process.env.SHELL ?? "/bin/sh", "-lc", command], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (exitCode !== 0) throw new Error(`Secret command failed with exit code ${exitCode}: ${stderr.trim()}`);
		const resolved = stdout.trim();
		if (!resolved) throw new Error("Secret command returned an empty value");
		return resolved;
	}
	return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced: string | undefined, plain: string | undefined) => {
		const name = braced ?? plain;
		const resolved = name ? env[name] : undefined;
		if (resolved === undefined) throw new Error(`Environment variable ${name} is not set`);
		return resolved;
	});
}
