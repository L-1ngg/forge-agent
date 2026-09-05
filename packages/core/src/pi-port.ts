import {
	InMemoryCredentialStore,
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
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { block, permissionScopeForToolCall, type BlockEnvelope, type ExecuteBlockData, type SessionContentBlock, type SessionEvent, type SessionMessage, type StopReason, type ToolCallBlock } from "@forge-agent/protocol";
import { type HarnessTool, type ToolContext, type ToolInputRewrite } from "@forge-agent/tools";
import { createEditBlockData } from "./diff.ts";
import { decide, formatPermissionRule, type PermissionContext } from "./permission/index.ts";
import type { AgentPort } from "./agent-runner.ts";
import { permissionResultFromOutcome, type RequestBus } from "./request-bus.ts";
import { ExecutionCore } from "./execution-core.ts";

export interface PiPortOptions {
	provider: string;
	model: string;
	baseUrl?: string;
	apiKey?: string;
	systemPrompt: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	cwd: string;
	history?: SessionMessage[];
	tools?: HarnessTool<object, unknown>[];
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

export interface PiTestPortOptions {
	responses: PiTestResponse[];
	tools?: HarnessTool<object, unknown>[];
	/** Rewrite tool input before execution; permission checks observe the rewritten object. */
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	cwd?: string;
	tokensPerSecond?: number;
	requestBus?: RequestBus;
	permission?: PermissionContext;
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function toProtocolStopReason(reason: AssistantMessage["stopReason"]): StopReason | undefined {
	if (reason === "pending") return undefined;
	if (reason === "toolUse") return "tool_use";
	return reason;
}

function toPiStopReason(reason: StopReason | undefined): AssistantMessage["stopReason"] {
	if (reason === undefined) return "stop";
	if (reason === "tool_use") return "toolUse";
	return reason;
}

function toSessionContent(message: Message): SessionContentBlock[] {
	if (message.role === "user") {
		if (typeof message.content === "string") return [{ type: "text", text: message.content }];
		return message.content.map((block) =>
			block.type === "text" ? { type: "text" as const, text: block.text } : { type: "text" as const, text: `[image: ${block.mimeType}]` },
		);
	}
	if (message.role === "toolResult") {
		return message.content.map((block) =>
			block.type === "text" ? { type: "text" as const, text: block.text } : { type: "text" as const, text: `[image: ${block.mimeType}]` },
		);
	}
	return message.content.map((block) => {
		if (block.type === "text") return { type: "text" as const, text: block.text, ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}) };
		if (block.type === "thinking") return {
			type: "thinking" as const, thinking: block.thinking,
			...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
			...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
		};
		return {
			type: "tool_call" as const, id: block.id, name: block.name, arguments: block.arguments,
			...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
			...(block.namespace !== undefined ? { namespace: block.namespace } : {}),
		};
	});
}

function toSessionMessage(message: Message): SessionMessage | undefined {
	if (typeof message !== "object" || message === null || !("role" in message)) return undefined;
	const standard = message as Message;
	if (standard.role !== "user" && standard.role !== "assistant" && standard.role !== "toolResult") return undefined;
	const base: SessionMessage = {
		role: standard.role,
		content: toSessionContent(standard),
		timestamp: standard.timestamp,
	};
	if (standard.role === "assistant") {
		const stopReason = toProtocolStopReason(standard.stopReason);
		return {
			...base,
			provider: standard.provider,
			model: standard.model,
			api: standard.api,
			usage: {
				input: standard.usage.input,
				output: standard.usage.output,
				cacheRead: standard.usage.cacheRead,
				cacheWrite: standard.usage.cacheWrite,
				totalTokens: standard.usage.totalTokens,
				cost: { ...standard.usage.cost },
			},
			...(stopReason !== undefined ? { stopReason } : {}),
			...(standard.errorMessage ? { errorMessage: standard.errorMessage } : {}),
		};
	}
	if (standard.role === "toolResult") {
		return { ...base, toolCallId: standard.toolCallId, toolName: standard.toolName, isError: standard.isError };
	}
	return base;
}

function zeroUsage(): NonNullable<AssistantMessage["usage"]> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function fromSessionMessage(message: SessionMessage, model: Model<string>): Message {
	const textAndImages = message.content
		.filter((block) => block.type === "text")
		.map((block) => ({ type: "text" as const, text: block.text }));
	if (message.role === "user") {
		return { role: "user", content: textAndImages, timestamp: message.timestamp } satisfies UserMessage;
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			toolCallId: message.toolCallId ?? "unknown",
			toolName: message.toolName ?? "unknown",
			content: textAndImages,
			isError: message.isError ?? false,
			timestamp: message.timestamp,
		} satisfies ToolResultMessage;
	}
	return {
		role: "assistant",
		content: message.content.map((block) => {
			if (block.type === "text" || block.type === "thinking") return { ...block };
			return { ...block, type: "toolCall" as const };
		}),
		api: message.api ?? model.api,
		provider: message.provider ?? model.provider,
		model: message.model ?? model.id,
		usage: message.usage ? mergeUsage(message.usage) : zeroUsage(),
		stopReason: toPiStopReason(message.stopReason),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
		timestamp: message.timestamp,
	} satisfies AssistantMessage;
}

function mergeUsage(usage: NonNullable<SessionMessage["usage"]>): NonNullable<AssistantMessage["usage"]> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...(usage.cost ?? {}) },
	};
}

function decorateToolEvent(event: SessionEvent, commands: Map<string, string>, edits: Map<string, BlockEnvelope<"edit">>): SessionEvent {
	if (event.type === "tool_execution_start") {
		rememberToolCommand(commands, event.toolCallId, event.toolName, event.args);
		const envelope = startToolBlock(event.toolCallId, event.toolName, event.args, event.timestamp);
		if (envelope?.kind === "edit") edits.set(event.toolCallId, envelope as BlockEnvelope<"edit">);
		return envelope ? { ...event, block: envelope } : event;
	}
	if (event.type === "tool_execution_end") {
		const edit = edits.get(event.toolCallId);
		let result: unknown;
		try { result = JSON.parse(event.content); } catch { result = event.content; }
		const envelope = edit
			? { ...edit, lifecycle: event.isError ? "failed" as const : "complete" as const, updatedAt: event.timestamp }
			: executeToolBlock(event.toolCallId, event.toolName, result, event.isError ? "failed" : "complete", event.timestamp, commands.get(event.toolCallId));
		commands.delete(event.toolCallId);
		edits.delete(event.toolCallId);
		return envelope ? { ...event, block: envelope } : event;
	}
	return event;
}

function startToolBlock(toolCallId: string, toolName: string, args: unknown, timestamp: number): BlockEnvelope<"edit" | "execute"> | undefined {
	const values = objectValue(args);
	if (toolName === "edit" && typeof values.path === "string" && typeof values.old_text === "string" && typeof values.new_text === "string") {
		return block(
			{ id: toolCallId, kind: "edit", lifecycle: "streaming", defaultDisplayMode: "expanded", currentDisplayMode: "expanded", manualOverride: false, colorSlot: "accent_edit", createdAt: timestamp, updatedAt: timestamp },
			createEditBlockData(values.path, values.old_text, values.new_text),
			{ defaultDisplayMode: "expanded", respectManualFolds: true },
		);
	}
	if (toolName !== "bash" || typeof values.command !== "string") return undefined;
	return block(
		{ id: toolCallId, kind: "execute", lifecycle: "streaming", defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false, colorSlot: "accent_execute", createdAt: timestamp, updatedAt: timestamp },
		{ command: values.command },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3, respectManualFolds: true },
	);
}

function executeToolBlock(toolCallId: string, toolName: string, result: unknown, lifecycle: "streaming" | "complete" | "failed", timestamp: number, fallbackCommand?: string): BlockEnvelope<"execute"> | undefined {
	if (toolName !== "bash") return undefined;
	const wrapper = objectValue(result);
	const details = objectValue(wrapper.details ?? result);
	const content = Array.isArray(wrapper.content)
		? wrapper.content.map((entry) => objectValue(entry).text).filter((entry): entry is string => typeof entry === "string").join("\n")
		: "";
	const structuredError = lifecycle === "failed" ? readableToolError(content) : undefined;
	const data: ExecuteBlockData = {
		command: typeof details.command === "string" ? details.command : fallbackCommand ?? "bash",
		...(typeof details.stdout === "string" ? { stdout: details.stdout } : content && structuredError === undefined ? { stdout: content } : {}),
		...(typeof details.stderr === "string" ? { stderr: details.stderr } : structuredError !== undefined ? { stderr: structuredError } : {}),
		...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
		...(lifecycle === "failed" ? { isError: true } : {}),
	};
	return block(
		{ id: toolCallId, kind: "execute", lifecycle, defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false, colorSlot: "accent_execute", updatedAt: timestamp },
		data,
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3, respectManualFolds: true },
	);
}

function rememberToolCommand(commands: Map<string, string>, toolCallId: string, toolName: string, args: unknown): void {
	if (toolName !== "bash") return;
	const command = objectValue(args).command;
	if (typeof command === "string") commands.set(toolCallId, command);
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** forge-agent tools throw structured errors; show the human message instead of raw JSON. */
function readableToolError(content: string): string | undefined {
	try {
		const value = objectValue(JSON.parse(content));
		return typeof value.error_code === "string" && typeof value.message === "string" ? value.message : undefined;
	} catch {
		return undefined;
	}
}

export interface PermissionHookOptions {
	context: PermissionContext;
	requestBus?: RequestBus;
	/** Legacy escape hatch for callers that own a separate authorization path. */
	skipTools?: ReadonlySet<string>;
	/** Prepare the final tool input before permission is evaluated. */
	prepareToolCall?: (toolCall: ToolCallBlock, signal?: AbortSignal) => Promise<ToolCallBlock>;
	/** Retain an authorized final input for the matching tool execution. */
	markPreparedInput?: (toolCall: ToolCallBlock) => void;
}

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

export interface BeforeToolCallContext {
	toolCall: { type: string; id: string; name: string; arguments: Record<string, unknown> };
	args?: unknown;
}

export interface BeforeToolCallResult {
	block: true;
	reason: string;
	terminate: true;
}

export function createPermissionBeforeToolCall(options: PermissionHookOptions): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
	return async (context, signal) => {
		if (options.skipTools?.has(context.toolCall.name)) return undefined;
		const rawToolCall = makeToolCall(context.toolCall.id, context.toolCall.name, context.args ?? context.toolCall.arguments);
		const toolCall = options.prepareToolCall ? await options.prepareToolCall(rawToolCall, signal) : rawToolCall;
		const check = await checkPermission(toolCall, options, signal);
		if (check.allowed) {
			options.markPreparedInput?.(toolCall);
			return undefined;
		}
		return { block: true, reason: check.reason, terminate: true };
	};
}

interface ModelPortOptions {
	model: Model<string>;
	stream: (model: Model<string>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	systemPrompt: string;
	thinkingLevel: PiPortOptions["thinkingLevel"];
	history?: SessionMessage[];
	tools?: HarnessTool<object, unknown>[];
	cwd: string;
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	permission?: PermissionContext;
	requestBus?: RequestBus;
}

function createModelPort(options: ModelPortOptions): AgentPort {
	const tools = options.tools ?? [];
	const modelTools = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: Type.Unsafe(tool.parameters) }));
	const core = new ExecutionCore({
		contextWindow: options.model.contextWindow,
		abortInteractions: () => { options.requestBus?.abort(); },
		async stream(messages, signal, emit) {
			let started = false;
			const stream = options.stream(options.model, {
				systemPrompt: options.systemPrompt,
				messages: messages.map((message) => fromSessionMessage(message, options.model)),
				tools: modelTools,
			}, { signal, ...(options.thinkingLevel !== "off" ? { reasoning: options.thinkingLevel } : {}) });
			for await (const event of stream) {
				if (!started && event.type !== "done" && event.type !== "error") {
					started = true;
					const message = toSessionMessage(event.partial);
					if (message) emit({ type: "message_start", timestamp: Date.now(), message });
				}
				if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
					emit({ type: "message_delta", timestamp: Date.now(), contentIndex: event.contentIndex, contentType: event.type === "text_delta" ? "text" : event.type === "thinking_delta" ? "thinking" : "tool_call", delta: event.delta });
				}
			}
			const result = toSessionMessage(await stream.result());
			if (!result) throw new Error("Provider did not return an assistant message");
			if (!started) emit({ type: "message_start", timestamp: Date.now(), message: result });
			return result;
		},
		async execute(call, signal) {
			signal.throwIfAborted();
			const index = tools.findIndex((tool) => tool.name === call.name);
			const tool = tools[index];
			const schema = modelTools[index];
			if (!tool || !schema) throw new Error(`Tool ${call.name} not found`);
			let input = validateToolArguments(schema, { ...call, type: "toolCall" }) as object;
			const context: ToolContext = { cwd: options.cwd, toolCallId: call.id, signal };
			const rewrite = options.toolInputRewrites?.[call.name];
			if (rewrite) input = await rewrite(input, context);
			signal.throwIfAborted();
			input = validateToolArguments(schema, { ...call, type: "toolCall", arguments: input as Record<string, unknown> }) as object;
			const finalCall = { ...call, arguments: input as Record<string, unknown> };
			if (options.permission) {
				const check = await checkPermission(finalCall, { context: options.permission, ...(options.requestBus ? { requestBus: options.requestBus } : {}) }, signal);
				if (!check.allowed) return {
					terminate: true,
					message: { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp: Date.now(), content: [{ type: "text", text: check.reason }] },
				};
			}
			signal.throwIfAborted();
			const outcome = await tool.execute(input, context);
			return {
				...(outcome.ok ? { details: outcome.value } : {}),
				message: {
					role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: Date.now(),
					isError: !outcome.ok,
					content: [{ type: "text", text: stringify(outcome.ok ? outcome.value : outcome.error) }],
				},
			};
		},
	}, options.history);
	return {
		async *runTurn(input) {
			const commands = new Map<string, string>();
			const edits = new Map<string, BlockEnvelope<"edit">>();
			try {
				for await (const event of core.runTurn(input)) yield decorateToolEvent(event, commands, edits);
			} finally {
				commands.clear();
				edits.clear();
			}
		},
		steer: (input) => core.steer(input),
		followUp: (input) => core.followUp(input),
		abort: () => core.abort(),
		getUsage: () => core.getUsage(),
	};
}

export async function createPiPort(options: PiPortOptions): Promise<AgentPort> {
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
	return createModelPort({ ...options, model, stream: models.streamSimple.bind(models) });
}

function lastUserText(messages: Message[]): string {
	let message: UserMessage | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
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
	return createModelPort({
		...options,
		model: faux.getModel(),
		stream: models.streamSimple.bind(models),
		systemPrompt: "execution contract test",
		thinkingLevel: "off",
		cwd: options.cwd ?? process.cwd(),
	});
}
