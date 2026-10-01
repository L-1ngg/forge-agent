import type { McpOptions, McpController } from "./mcp/types.ts";
import type { TransformContext } from "./context/transform.ts";
import type { ShouldStopAfterTurn } from "./turn-policy.ts";
import type { SkillsOptions, SkillsSnapshot, AgentInput } from "./skills/types.ts";
import type { TurnResult, SessionTurn, RequestEnvelopeUnion, ResponseEnvelope, SessionEvent } from "@forge-agent/protocol";
import type { ConfigurationPatch, ConfigurationReceipt } from "./configuration.ts";
import type { HarnessTool } from "@forge-agent/tools";
import type { Model } from "./model-types.ts";
import type { ModelAdapter } from "./model-adapter.ts";
import type { ToolHooks } from "./session-tools.ts";
import type { OtelMiddlewareOptions } from "@tanstack/ai/middlewares/otel";
import { MemoryPermissionStore, type PermissionContext } from "./permission/index.ts";
import { RequestBus } from "./request-bus.ts";
import { MemorySessionStorage, validateSessionState, type SessionStorage } from "./session-storage.ts";
import type { UsageTruthPoint } from "./usage.ts";
import type { CompactionResult, ContextSettings, RetryPolicy } from "./context/compaction.ts";
import type { MemoryOptions } from "./memory/tools.ts";
import { snapshotConfiguration } from "./session-configuration.ts";
import { assembleAgent } from "./session-assembly.ts";

export type { TurnResult } from "@forge-agent/protocol";
export type InputQueueMode = "all" | "one-at-a-time";
export interface InputQueueOptions { steeringMode?: InputQueueMode; followUpMode?: InputQueueMode; }
export type InputAcceptance = { accepted: false; } | { accepted: true; processed: Promise<boolean>; inputId?: string; };

export interface CreateAgentOptions extends InputQueueOptions {
	mcp?: McpOptions | false;
	shouldStopAfterTurn?: ShouldStopAfterTurn;
	transformContext?: TransformContext;
	skills?: SkillsOptions | false;
	memory?: MemoryOptions;
	toolHooks?: ToolHooks;
	/** Official TanStack OTel options. The host owns tracer/meter lifecycle. */
	otel?: OtelMiddlewareOptions;
	sessionId?: string;
	context?: Partial<ContextSettings>;
	retry?: Partial<RetryPolicy>;
	maxTokens?: number;
	contextWindow?: number;
	provider?: string;
	model: string | Model<string>;
	/** Native TanStack adapter shared by task and summary requests; null restores the catalog adapter. */
	adapter?: ModelAdapter | null;
	apiKey?: string;
	baseUrl?: string;
	systemPrompt: string;
	cwd: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: Array<HarnessTool<object, unknown>>;
	permission?: PermissionContext;
	storage?: SessionStorage;
	requestBus?: RequestBus;
}
export interface AgentTurn extends SessionTurn {
	readonly id: symbol;
	readonly inputId?: string;
	readonly result: Promise<TurnResult>;
}
export interface Agent {
	readonly mcp: McpController;
	readonly requests: AsyncIterable<RequestEnvelopeUnion>;
	runTurn(input: AgentInput): AgentTurn;
	continue(): AgentTurn;
	steer(input: AgentInput, expectedTurnId: symbol): InputAcceptance;
	followUp(input: AgentInput, expectedTurnId: symbol): InputAcceptance;
	abort(): void;
	waitForIdle(): Promise<void>;
	updateConfiguration(patch: ConfigurationPatch): Promise<ConfigurationReceipt>;
	getSkills(): SkillsSnapshot;
	refreshSkills(): Promise<ConfigurationReceipt>;
	getUsage(): UsageTruthPoint | undefined;
	configureContext(settings: Partial<ContextSettings>): void;
	compact(instructions?: string, emit?: (event: SessionEvent) => void): Promise<CompactionResult>;
	respond(response: ResponseEnvelope): boolean;
	dispose(): Promise<void>;
}

export async function createAgent(options: CreateAgentOptions): Promise<Agent> {
	if (arguments.length !== 1) throw new TypeError("createAgent accepts one options argument; use adapter, storage or tools for customization");
	if ("streamFn" in options) throw new TypeError("streamFn was removed; supply a native TanStack adapter");
	if (options.shouldStopAfterTurn !== undefined && typeof options.shouldStopAfterTurn !== "function") throw new TypeError("shouldStopAfterTurn must be a function");
	if (options.transformContext !== undefined && typeof options.transformContext !== "function") throw new TypeError("transformContext must be a function");
	const captured = snapshotConfiguration(options);
	const storage = captured.storage ?? new MemorySessionStorage();
	const bus = captured.requestBus ?? new RequestBus();
	try {
		const state = await storage.load();
		validateSessionState(state);
		return await assembleAgent({ ...captured, permission: { ...captured.permission, memory: captured.permission?.memory ?? new MemoryPermissionStore() } }, storage, bus, state);
	} catch (error) {
		if (!captured.requestBus) bus.close();
		throw error;
	}
}
