import { McpManager } from "./mcp/manager.ts";
import type { McpOptions } from "./mcp/types.ts";
import type { TransformContext } from "./context/transform.ts";
import type { ShouldStopAfterTurn } from "./turn-policy.ts";
import { discoverSkills } from "./skills/catalog.ts";
import type { SkillsOptions } from "./skills/types.ts";
import { snapshotConfiguration, prepareSessionConfiguration } from "./session-configuration.ts";
import type { ConfigurationPatch } from "./configuration.ts";
import type { AgentOptions as RuntimeOptions } from "./runtime/agent.ts";
import type { StreamFn } from "./runtime/types.ts";
import { AgentSession } from "./agent-session.ts";
import type { Model } from "./model-types.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import { type HarnessTool, type ToolInputRewrite } from "@forge-agent/tools";
import type { PermissionContext } from "./permission/index.ts";
import type { AgentPort, InputQueueOptions } from "./agent-port.ts";
import type { RequestBus } from "./request-bus.ts";
import type { ContextSettings, RetryPolicy } from "./context/compaction.ts";
import type { MemoryOptions } from "./memory/tools.ts";

export type ToolHooks = Pick<RuntimeOptions, "beforeToolCall" | "afterToolCall" | "toolExecution">;
export type { Model, StreamFn };

export interface SessionPortOptions extends InputQueueOptions {
	mcp?: McpOptions | false;
	shouldStopAfterTurn?: ShouldStopAfterTurn;
	transformContext?: TransformContext;
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
	/** Model stream protocol; null selects the built-in transport for a catalog model. */
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
	mcpManager?: McpManager;
	/** Internal resolved transport identity, committed with configuration. */
	builtinStream?: boolean;
	shouldStopAfterTurn?: ShouldStopAfterTurn;
	transformContext?: TransformContext;
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
	thinkingLevel: SessionPortOptions["thinkingLevel"];
	history?: SessionMessage[];
	tools?: Array<HarnessTool<object, unknown>>;
	cwd: string;
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	permission?: PermissionContext;
	requestBus?: RequestBus;
}

/** Assemble the single source-owned session runtime. */
export async function createSessionPort(options: SessionPortOptions): Promise<AgentPort> {
 const manager = new McpManager(options.mcp, { cwd: options.cwd, ...(options.permission ? { permission: options.permission } : {}), ...(options.requestBus ? { requestBus: options.requestBus } : {}) });
 let desired = snapshotConfiguration(options);
 let catalog = await discoverSkills(desired.skills, desired.cwd);
 const prepare = async (next: SessionPortOptions, nextCatalog: typeof catalog, signal?: AbortSignal) => {
   const assembly = await prepareSessionConfiguration(next, nextCatalog);
   const mcpConfig = next.mcp ? { enabled: next.mcp.enabled ?? true, servers: next.mcp.servers } : next.mcp;
   const mcp = await manager.prepare(mcpConfig, [...(next.tools ?? []).map(tool => tool.name), "load_skill", "read_context", "search_context"], signal);
   assembly.mcp = mcp; assembly.options.mcpManager = manager;
   if (mcp.instructions) assembly.options.systemPrompt += "\n\n" + mcp.instructions;
   assembly.options.tools = [...assembly.options.tools ?? [], ...mcp.tools];
   return assembly;
 };
 try {
   const initial = await prepare(desired, catalog);
   initial.mcp!.commit(0);
   const session = new AgentSession(initial, async (patch: ConfigurationPatch, refresh = false, signal?: AbortSignal) => {
     const next = snapshotConfiguration({ ...desired, ...patch });
     const nextCatalog = refresh || "skills" in patch ? await discoverSkills(next.skills, next.cwd, signal) : catalog;
     const assembly = await prepare(next, nextCatalog, signal);
     if (signal?.aborted) { await assembly.mcp?.discard(); signal.throwIfAborted(); }
     catalog = nextCatalog; desired = next;
     return assembly;
   });
   manager.bind(patch => session.updateConfiguration(patch));
   return session;
 } catch (error) { await manager.dispose(); throw error; }
}
