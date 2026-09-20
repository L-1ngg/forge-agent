import type { ShouldStopAfterTurn } from "./turn-policy.ts";
import { discoverSkills } from "./skills/catalog.ts";
import type { SkillsOptions } from "./skills/types.ts";
import { snapshotConfiguration, prepareSessionConfiguration } from "./session-configuration.ts";
import type { ConfigurationPatch } from "./configuration.ts";
import type { AgentOptions as RuntimeOptions } from "./runtime/agent.ts";
import type { StreamFn } from "./runtime/types.ts";
import { AgentSession } from "./agent-session.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionMessage } from "@forge-agent/protocol";
import { type HarnessTool, type ToolInputRewrite } from "@forge-agent/tools";
import type { PermissionContext } from "./permission/index.ts";
import type { AgentPort, InputQueueOptions } from "./agent-port.ts";
import type { RequestBus } from "./request-bus.ts";
import type { ContextSettings, RetryPolicy } from "./context/compaction.ts";
import type { MemoryOptions } from "./memory/tools.ts";

export type ToolHooks = Pick<RuntimeOptions, "beforeToolCall" | "afterToolCall" | "toolExecution">;
export type { Model, StreamFn };

export interface PiPortOptions extends InputQueueOptions {
	shouldStopAfterTurn?: ShouldStopAfterTurn;
	skills?: SkillsOptions | false;
	memory?: MemoryOptions;
	toolHooks?: ToolHooks;
	sessionId?: string;
	context?: Partial<ContextSettings>;
	retry?: Partial<RetryPolicy>;
	maxTokens?: number;
	contextWindow?: number;
	provider?: string;
	model: string | Model<string>;
	/** Pi stream protocol; null selects the built-in transport for a catalog model. */
	streamFn?: StreamFn | null;
	baseUrl?: string;
	apiKey?: string;
	systemPrompt: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	cwd: string;
	history?: SessionMessage[];
	tools?: Array<HarnessTool<object, unknown>>;
	/**
	 * Rewrite tool input before execution; permission checks observe the rewritten object.
	 * The core emits `tool_execution_start` before this wrapper runs, so that event can
	 * retain the model's original args even though policy and execution use the final input.
	 */
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	requestBus?: RequestBus;
	permission?: PermissionContext;
}

export interface ModelPortOptions extends InputQueueOptions {
	shouldStopAfterTurn?: ShouldStopAfterTurn;
	memory?: MemoryOptions;
	toolHooks?: ToolHooks;
	context?: Partial<ContextSettings>;
	retry?: Partial<RetryPolicy>;
	maxTokens?: number;
	contextWindow?: number;
	model: Model<string>;
	streamFn: StreamFn;
	apiKey?: string;
	sessionId?: string;
	systemPrompt: string;
	thinkingLevel: PiPortOptions["thinkingLevel"];
	history?: SessionMessage[];
	tools?: Array<HarnessTool<object, unknown>>;
	cwd: string;
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	permission?: PermissionContext;
	requestBus?: RequestBus;
}

/** Assemble the single source-owned session runtime. */
export async function createPiPort(options: PiPortOptions): Promise<AgentPort> {
	let desired = snapshotConfiguration(options);
	let catalog = await discoverSkills(desired.skills, desired.cwd);
	const initial = await prepareSessionConfiguration(desired, catalog);
	return new AgentSession(initial, async (patch: ConfigurationPatch, refresh = false, signal?: AbortSignal) => {
		const next = snapshotConfiguration({ ...desired, ...patch });
		const nextCatalog = refresh || "skills" in patch ? await discoverSkills(next.skills, next.cwd, signal) : catalog;
		const assembly = await prepareSessionConfiguration(next, nextCatalog);
		signal?.throwIfAborted();
		catalog = nextCatalog;
		desired = next;
		return assembly;
	});
}
