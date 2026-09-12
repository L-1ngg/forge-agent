import type { ConfigurationPatch, SessionAssembly } from "./configuration.ts";
import type { AgentOptions as RuntimeOptions } from "./runtime/agent.ts";
import type { AgentTool } from "./runtime/types.ts";
import { fromSessionMessage, toSessionMessage, toPiStopReason } from "./event-projection.ts";
import { AgentSession } from "./agent-session.ts";
import {
	InMemoryCredentialStore,
	getSupportedThinkingLevels,
	isRetryableAssistantError,
	isContextOverflow,
	Type,
	validateToolArguments,
	type AssistantMessageEventStream,
	type Context,
	type SimpleStreamOptions,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import { permissionScopeForToolCall, type SessionMessage, type StopReason, type ToolCallBlock } from "@forge-agent/protocol";
import { type HarnessTool, type ToolInputRewrite } from "@forge-agent/tools";
import { decide, formatPermissionRule, type PermissionContext } from "./permission/index.ts";
import type { AgentPort, InputQueueOptions } from "./agent-port.ts";
import { permissionResultFromOutcome, type RequestBus } from "./request-bus.ts";
import { SUMMARY_SYSTEM, resolveRetryPolicy, validateRequestLimits, type ContextSettings, type RetryPolicy, type SummaryDriver } from "./context/compaction.ts";
import { randomUUID } from "node:crypto";

export type ToolHooks = Pick<RuntimeOptions, "beforeToolCall" | "afterToolCall" | "toolExecution">;

export interface PiPortOptions extends InputQueueOptions {
	toolHooks?: ToolHooks;
	sessionId?: string;
	context?: Partial<ContextSettings>;
	retry?: Partial<RetryPolicy>;
	maxTokens?: number;
	contextWindow?: number;
	provider: string;
	model: string;
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

export interface PiTestResponse {
	text?: string;
	echoLastUser?: boolean;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	stopReason?: StopReason;
	errorMessage?: string;
}

export interface PiTestPortOptions extends InputQueueOptions {
	responses: PiTestResponse[];
	tools?: Array<HarnessTool<object, unknown>>;
	/** Rewrite tool input before execution; permission checks observe the rewritten object. */
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	cwd?: string;
	tokensPerSecond?: number;
	requestBus?: RequestBus;
	permission?: PermissionContext;
}

interface PermissionHookOptions { context: PermissionContext; requestBus?: RequestBus; }

function makeToolCall(id: string, name: string, argumentsValue: unknown): ToolCallBlock {
	return { type: "tool_call", id, name, arguments: argumentsValue as Record<string, unknown> };
}

interface PermissionCheckAllowed {
	allowed: true;
}

interface PermissionCheckDenied {
	allowed: false;
	reason: string;
}

type PermissionCheck = PermissionCheckAllowed | PermissionCheckDenied;

async function checkPermission(toolCall: ToolCallBlock, options: PermissionHookOptions, signal?: AbortSignal): Promise<PermissionCheck> {
	const decision = decide(toolCall, options.context);
	if (decision.kind === "allow") return { allowed: true };
	if (decision.kind === "deny") return { allowed: false, reason: decision.reason };
	if (!options.requestBus) return { allowed: false, reason: "Interactive permission request is unavailable" };

	const outcome = await options.requestBus.ask("permission", structuredClone(decision.payload), signal ? { signal } : {});
	const result = permissionResultFromOutcome(outcome);
	if (result.decision === "allow_once") return { allowed: true };
	if (result.decision === "allow_always") {
		const expectedScope = permissionScopeForToolCall(toolCall);
		if (!decision.payload.rememberRule || !options.context.memory || decision.payload.rememberRule !== formatPermissionRule(expectedScope)) {
			return { allowed: false, reason: "Always allow is unavailable for this tool call" };
		}
		if (result.scope.tool !== expectedScope.tool || result.scope.argsPattern !== expectedScope.argsPattern) {
			return { allowed: false, reason: "Permission scope differs from the rule shown for this tool call" };
		}
		options.context.memory.remember(result.scope);
		return { allowed: true };
	}
	return { allowed: false, reason: result.reason ?? "Tool execution denied" };
}

export interface ModelPortOptions extends InputQueueOptions {
	toolHooks?: ToolHooks;
	context?: Partial<ContextSettings>;
	retry?: Partial<RetryPolicy>;
	maxTokens?: number;
	contextWindow?: number;
	model: Model<string>;
	stream: (model: Model<string>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
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

async function resolveModelOptions(options: PiPortOptions): Promise<ModelPortOptions> {
	resolveRetryPolicy(options.retry);
	validateRequestLimits(options);
	const credentials = new InMemoryCredentialStore();
	const apiKey = options.apiKey;
	if (apiKey) await credentials.modify(options.provider, async () => ({ type: "api_key", key: apiKey }));
	const models = builtinModels({ credentials });
	const catalogModel = models.getModel(options.provider, options.model);
	if (!catalogModel) throw new Error(`Unknown model ${options.provider}/${options.model}`);
	if (!await models.checkAuth(options.provider)) {
		throw new Error(`Provider is not configured: ${options.provider}. Set apiKey in .forge-agent/config.json, FORGE_AGENT_API_KEY, or the provider's API key environment variable.`);
	}
	const model = options.baseUrl ? { ...catalogModel, baseUrl: options.baseUrl } : catalogModel;
	return { ...options, sessionId: options.sessionId ?? randomUUID(), model, stream: models.streamSimple.bind(models) };
}

/** Assemble the single source-owned session runtime. */
export async function createPiPort(options: PiPortOptions): Promise<AgentPort> {
	let desired = snapshotOptions(options);
	const assemble = async (configuration: PiPortOptions): Promise<SessionAssembly> => {
		if (typeof configuration.systemPrompt !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(configuration.thinkingLevel)) throw new Error("Invalid model configuration");
		const model = await resolveModelOptions(configuration);
		return { options: model, toolset: prepareSessionTools(model), driver: createSummaryDriver(model) };
	};
	const initial = await assemble(desired);
	return new AgentSession(initial, async (patch: ConfigurationPatch) => {
		const next = snapshotOptions({ ...desired, ...patch });
		const assembly = await assemble(next);
		desired = next;
		return assembly;
	});
}

function lastUserText(messages: Message[]): string {
	let message: UserMessage | undefined;
	for (let index = messages.length - 1;index >= 0;index--) {
		const candidate = messages[index];
		if (candidate?.role === "user") {
			message = candidate;
			break;
		}
	}
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function createPiTestPort(options: PiTestPortOptions): AgentPort {
	const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 10_000, tokenSize: { min: 1, max: 1 } });
	faux.setResponses(
		options.responses.map((response) => (context) => {
			const content = [
				...((response.echoLastUser ? lastUserText(context.messages) : response.text) ? [fauxText(response.echoLastUser ? lastUserText(context.messages) : (response.text ?? ""))] : []),
				...(response.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.arguments, { id: call.id })),
			];
			const stopReason = toPiStopReason(response.stopReason ?? (response.toolCalls?.length ? "tool_use" : "stop"));
			return fauxAssistantMessage(content, {
				stopReason,
				...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
				...(stopReason === "deferred"
					? { deferred: { provider: "faux", modelId: "faux-1", api: "faux", id: "deferred-test" } }
					: {}),
			});
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const configured: ModelPortOptions = {
		...options,
		model: faux.getModel(),
		stream: models.streamSimple.bind(models),
		systemPrompt: "execution contract test",
		thinkingLevel: "off",
		cwd: options.cwd ?? process.cwd(),
	};
	const assembly = { options: configured, toolset: prepareSessionTools(configured), driver: createSummaryDriver(configured) };
	return new AgentSession(assembly, async () => { throw new Error("Scripted provider does not support model reconfiguration"); });
}

/** Bridge host cwd/error outcomes to native tool scheduling; preparation and policy
 * remain serial preflight, never inside concurrently started execute promises. */
export function prepareSessionTools(options: ModelPortOptions) {
	const prepared = new Map<string, object>();
	const tools: AgentTool[] = (options.tools ?? []).map(tool => ({
		name: tool.name, label: tool.label, description: tool.description, parameters: Type.Unsafe(tool.parameters),
		...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		async execute(id, _args, signal, onUpdate) {
			signal?.throwIfAborted();
			const input = prepared.get(id);
			prepared.delete(id);
			if (!input) throw new Error("Tool input has not been authorized");
			const snapshot = <T>(result: T): T => { JSON.stringify(result); return structuredClone(result); };
			return snapshot(await tool.execute(input, { cwd: options.cwd, toolCallId: id, ...(signal ? { signal } : {}), ...(onUpdate ? { onUpdate: result => onUpdate(snapshot(result)) } : {}) }));
		},
	}));
	const beforeToolCall: NonNullable<RuntimeOptions["beforeToolCall"]> = async (context, signal) => {
		signal?.throwIfAborted();
		prepared.delete(context.toolCall.id);
		const schema = tools.find(tool => tool.name === context.toolCall.name)!;
		const nativeArgs = context.args as Record<string, unknown>;
		let args = nativeArgs;
		const rewrite = options.toolInputRewrites?.[context.toolCall.name];
		if (rewrite) args = await rewrite(args, { cwd: options.cwd, toolCallId: context.toolCall.id, ...(signal ? { signal } : {}) }) as Record<string, unknown>;
		args = validateToolArguments(schema, { ...context.toolCall, arguments: args });
		const result = await options.toolHooks?.beforeToolCall?.({ ...context, args }, signal);
		if (result?.block) return result;
		signal?.throwIfAborted();
		const finalArgs = structuredClone(validateToolArguments(schema, { ...context.toolCall, arguments: args }));
		const finalCall = makeToolCall(context.toolCall.id, context.toolCall.name, finalArgs);
		const check = await checkPermission(finalCall, { context: options.permission ?? {}, ...(options.requestBus ? { requestBus: options.requestBus } : {}) }, signal);
		if (!check.allowed) return { block: true, reason: check.reason, terminate: true };
		signal?.throwIfAborted();
		prepared.set(context.toolCall.id, finalArgs);
		// Native after hook sees the same values that were authorized and executed.
		for (const key of Object.keys(nativeArgs)) delete nativeArgs[key];
		Object.assign(nativeArgs, finalArgs);
		return result;
	};
	const afterToolCall: NonNullable<RuntimeOptions["afterToolCall"]> = async (context, signal) => {
		const isError = context.isError || ("isError" in context.result && context.result.isError === true);
		const override = await options.toolHooks?.afterToolCall?.({ ...context, isError }, signal);
		const result = { ...context.result, isError, ...Object.fromEntries(Object.entries(override ?? {}).filter(([, value]) => value !== undefined)) };
		JSON.stringify(result);
		return structuredClone(result);
	};
	return { tools, beforeToolCall, afterToolCall, ...(options.toolHooks?.toolExecution ? { toolExecution: options.toolHooks.toolExecution } : {}), clear: () => prepared.clear() };
}

function createSummaryDriver(options: ModelPortOptions): SummaryDriver & { isOverflow(message: SessionMessage): boolean } {
	const summaryThinking = (requested: "inherit" | "off") => requested === "off" && !getSupportedThinkingLevels(options.model).includes("off")
		? { level: options.thinkingLevel, fallback: "Model does not support reasoning off; inherited task reasoning" }
		: { level: requested === "off" ? "off" as const : options.thinkingLevel };
	return {
		maxTokens: options.model.maxTokens,
		outputTokens(requested, reasoning) {
			const level = summaryThinking(reasoning).level;
			const compat: unknown = Reflect.get(options.model, "compat");
			const adaptiveThinking = !!compat && typeof compat === "object" && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking === true;
			const budgeted = options.model.api === "anthropic-messages" || (options.model.api === "bedrock-converse-stream" && options.model.id.includes("anthropic"));
			return Math.min(options.model.maxTokens, requested + (budgeted && level !== "off" && !adaptiveThinking ? thinkingBudgetForLevel(level) : 0));
		},
		...(options.retry ? { retry: options.retry } : {}),
		summaryThinking,
		isOverflow: message => isContextOverflow(fromSessionMessage(message, options.model) as AssistantMessage, options.contextWindow ?? options.model.contextWindow),
		isRetryable: message => isRetryableAssistantError(fromSessionMessage(message, options.model) as AssistantMessage),
		async summarize(request, signal) {
			const thinking = summaryThinking(request.reasoning);
			const stream = options.stream(options.model, { systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] }, { signal, ...(options.sessionId ? { sessionId: options.sessionId } : {}), maxTokens: request.maxTokens, maxRetries: 0, cacheRetention: "none", ...(thinking.level !== "off" ? { reasoning: thinking.level } : {}) });
			for await (const _event of stream) { }
			const result = toSessionMessage(await stream.result());
			if (!result) throw new Error("Provider did not return a summary");
			return result;
		},
	};
}

function snapshotOptions(options: PiPortOptions): PiPortOptions {
	return { ...options, ...(options.context ? { context: { ...options.context } } : {}), ...(options.retry ? { retry: { ...options.retry } } : {}), ...(options.tools ? { tools: options.tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : {}) };
}
