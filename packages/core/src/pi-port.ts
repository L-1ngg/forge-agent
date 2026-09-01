import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import {
	InMemoryCredentialStore,
	Type,
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
import { block, permissionScopeForToolCall, type BlockEnvelope, type ExecuteBlockData, type SessionContentBlock, type SessionEvent, type SessionMessage, type StopReason, type TokenUsage } from "@myh/protocol";
import type { HarnessTool } from "@myh/tools";
import { createEditBlockData } from "./diff.ts";
import { decide, formatPermissionRule, type PermissionContext } from "./permission/index.ts";
import type { AgentPort } from "./agent-runner.ts";
import { permissionResultFromOutcome, type RequestBus } from "./request-bus.ts";
import { UsageTracker, type UsageTruthPoint } from "./usage.ts";

export interface PiPortOptions {
	provider: string;
	model: string;
	apiKey?: string;
	systemPrompt: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	cwd: string;
	history?: SessionMessage[];
	tools?: HarnessTool<object, unknown>[];
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
	cwd?: string;
	tokensPerSecond?: number;
	requestBus?: RequestBus;
	permission?: PermissionContext;
}

interface QueueWaiter<T> {
	resolve(result: IteratorResult<T>): void;
	reject(error: unknown): void;
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
	private readonly values: T[] = [];
	private readonly waiters: QueueWaiter<T>[] = [];
	private done = false;
	private error: unknown;

	push(value: T): void {
		if (this.done) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value, done: false });
		else this.values.push(value);
	}

	close(): void {
		if (this.done) return;
		this.done = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.done) return;
		this.error = error;
		this.done = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	next(): Promise<IteratorResult<T>> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve({ value, done: false });
		if (this.error !== undefined) return Promise.reject(this.error);
		if (this.done) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
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
		if (block.type === "text") return { type: "text" as const, text: block.text };
		if (block.type === "thinking") return { type: "thinking" as const, thinking: block.thinking };
		return { type: "tool_call" as const, id: block.id, name: block.name, arguments: block.arguments };
	});
}

function toSessionMessage(message: AgentMessage): SessionMessage | undefined {
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
			if (block.type === "text") return { type: "text" as const, text: block.text };
			if (block.type === "thinking") return { type: "thinking" as const, thinking: block.thinking };
			return { type: "toolCall" as const, id: block.id, name: block.name, arguments: block.arguments };
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

function eventTimestamp(): number {
	return Date.now();
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

function mapEvent(event: AgentEvent, toolCommands: Map<string, string>): SessionEvent[] {
	const timestamp = eventTimestamp();
	switch (event.type) {
		case "agent_start":
			return [{ type: "agent_start", timestamp }];
		case "agent_end":
			return [{ type: "agent_end", timestamp }];
		case "turn_start":
			return [{ type: "turn_start", timestamp }];
		case "turn_end": {
			const message = toSessionMessage(event.message);
			return [{ type: "turn_end", timestamp, ...(message?.stopReason ? { stopReason: message.stopReason } : {}) }];
		}
		case "message_start": {
			const message = toSessionMessage(event.message);
			return message ? [{ type: "message_start", timestamp, message }] : [];
		}
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") return [{ type: "message_delta", timestamp, contentIndex: update.contentIndex, contentType: "text", delta: update.delta }];
			if (update.type === "thinking_delta") return [{ type: "message_delta", timestamp, contentIndex: update.contentIndex, contentType: "thinking", delta: update.delta }];
			if (update.type === "toolcall_delta") return [{ type: "message_delta", timestamp, contentIndex: update.contentIndex, contentType: "tool_call", delta: update.delta }];
			return [];
		}
		case "message_end": {
			const message = toSessionMessage(event.message);
			return message ? [{ type: "message_end", timestamp, message }] : [];
		}
		case "tool_execution_start":
			rememberToolCommand(toolCommands, event.toolCallId, event.toolName, event.args);
			const startBlock = startToolBlock(event.toolCallId, event.toolName, event.args, timestamp);
			return [{
				type: "tool_execution_start",
				timestamp,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args as Record<string, unknown>,
				...(startBlock ? { block: startBlock } : {}),
			}];
		case "tool_execution_update":
			const updateBlock = executeToolBlock(event.toolCallId, event.toolName, event.partialResult, "streaming", timestamp, toolCommandFrom(toolCommands, event.toolCallId, event.args));
			return [{
				type: "tool_execution_update",
				timestamp,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				content: stringify(event.partialResult),
				...(updateBlock ? { block: updateBlock } : {}),
			}];
		case "tool_execution_end":
			const endBlock = executeToolBlock(event.toolCallId, event.toolName, event.result, event.isError ? "failed" : "complete", timestamp, toolCommands.get(event.toolCallId));
			toolCommands.delete(event.toolCallId);
			return [{
				type: "tool_execution_end",
				timestamp,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				content: stringify(event.result),
				isError: event.isError,
				...(endBlock ? { block: endBlock } : {}),
			}];
	}
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
	const data: ExecuteBlockData = {
		command: typeof details.command === "string" ? details.command : fallbackCommand ?? "bash",
		...(typeof details.stdout === "string" ? { stdout: details.stdout } : content ? { stdout: content } : {}),
		...(typeof details.stderr === "string" ? { stderr: details.stderr } : {}),
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

function toolCommandFrom(commands: Map<string, string>, toolCallId: string, args: unknown): string | undefined {
	const command = objectValue(args).command;
	return typeof command === "string" ? command : commands.get(toolCallId);
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function adaptTool(tool: HarnessTool<object, unknown>, cwd: string): AgentTool {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: Type.Unsafe(tool.parameters),
		async execute(_toolCallId, params, signal) {
			const outcome = await tool.execute(params as object, { cwd, ...(signal ? { signal } : {}) });
			if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
			return { content: [{ type: "text", text: stringify(outcome.value) }], details: outcome.value };
		},
	};
}

export interface PermissionHookOptions {
	context: PermissionContext;
	requestBus?: RequestBus;
}

/** Adapt the pure permission decision to pi's deny-only beforeToolCall hook. */
export function createPermissionBeforeToolCall(options: PermissionHookOptions): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
	return async (context, signal) => {
		const toolCall = {
			type: "tool_call" as const,
			id: context.toolCall.id,
			name: context.toolCall.name,
			arguments: (context.args ?? context.toolCall.arguments) as Record<string, unknown>,
		};
		const decision = decide(toolCall, options.context);
		if (decision.kind === "allow") return undefined;
		if (decision.kind === "deny") return { block: true, reason: decision.reason, terminate: true };
		if (!options.requestBus) return { block: true, reason: "Interactive permission request is unavailable", terminate: true };

		const outcome = await options.requestBus.ask("permission", decision.payload, signal ? { signal } : {});
		const result = permissionResultFromOutcome(outcome);
		if (result.decision === "allow_once") return undefined;
		if (result.decision === "allow_always") {
			const expectedScope = permissionScopeForToolCall(toolCall);
			if (!decision.payload.rememberRule || !options.context.memory || decision.payload.rememberRule !== formatPermissionRule(expectedScope)) {
				return { block: true, reason: "Always allow is unavailable for this tool call", terminate: true };
			}
			if (result.scope.tool !== expectedScope.tool || result.scope.argsPattern !== expectedScope.argsPattern) {
				return { block: true, reason: "Permission scope differs from the rule shown for this tool call", terminate: true };
			}
			options.context.memory?.remember(result.scope);
			return undefined;
		}
		return { block: true, reason: result.reason ?? "Tool execution denied", terminate: true };
	};
}

class PiAgentPort implements AgentPort {
	private readonly requestBus: RequestBus | undefined;
	private readonly usage: UsageTracker;

	constructor(private readonly agent: Agent, requestBus?: RequestBus) {
		this.requestBus = requestBus;
		this.usage = new UsageTracker({ contextWindow: agent.state.model.contextWindow });
		this.syncUsageContext();

		// Capture the exact context after pi applies its optional transform and
		// again at the provider boundary, where the final LLM message list exists.
		const previousTransform = agent.transformContext;
		agent.transformContext = async (messages, signal) => {
			const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
			this.usage.setContext({ messages: this.usageMessagesFrom(transformed), contextWindow: agent.state.model.contextWindow });
			return transformed;
		};
		const previousStreamFunction = agent.streamFunction;
		agent.streamFunction = (model, context, options) => {
			this.usage.setContext({ messages: this.usageMessagesFrom(context.messages), contextWindow: model.contextWindow });
			return previousStreamFunction(model, context, options);
		};
	}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		this.usage.beginTurn();
		this.syncUsageContext();
		const queue = new AsyncQueue<SessionEvent>();
		const toolCommands = new Map<string, string>();
		const unsubscribe = this.agent.subscribe((event) => {
			this.observeUsage(event);
			for (const mapped of mapEvent(event, toolCommands)) queue.push(mapped);
		});
		let completed = false;
		const running = this.agent.prompt(input).then(
			() => {
				completed = true;
				queue.close();
			},
			(error) => queue.fail(error),
		);
		try {
			for await (const event of queue) yield event;
			await running;
		} finally {
			if (!completed) this.agent.abort();
			unsubscribe();
			toolCommands.clear();
			this.usage.endTurn();
		}
	}

	steer(input: string): void {
		this.agent.steer({ role: "user", content: input, timestamp: Date.now() });
	}

	followUp(input: string): void {
		this.agent.followUp({ role: "user", content: input, timestamp: Date.now() });
	}

	abort(): void {
		this.requestBus?.abort();
		this.agent.abort();
	}

	getUsage(): UsageTruthPoint {
		return this.usage.snapshot();
	}

	private observeUsage(event: AgentEvent): void {
		if (event.type === "message_end") {
			this.syncUsageContext();
			if (event.message.role === "assistant") {
				const usage = toTokenUsage(event.message.usage);
				this.usage.recordUsage(usage);
			}
			return;
		}
		if (event.type === "tool_execution_end" || event.type === "turn_start") this.syncUsageContext();
	}

	private syncUsageContext(): void {
		this.usage.setContext({ messages: this.usageMessages(), contextWindow: this.agent.state.model.contextWindow });
	}

	private usageMessages(): SessionMessage[] {
		return this.usageMessagesFrom(this.agent.state.messages);
	}

	private usageMessagesFrom(messages: readonly AgentMessage[]): SessionMessage[] {
		return messages.flatMap((message) => {
			const converted = toSessionMessage(message);
			return converted ? [converted] : [];
		});
	}
}

function toTokenUsage(usage: AssistantMessage["usage"]): TokenUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

export async function createPiPort(options: PiPortOptions): Promise<AgentPort> {
	const credentials = new InMemoryCredentialStore();
	const apiKey = options.apiKey;
	if (apiKey) await credentials.modify(options.provider, async () => ({ type: "api_key", key: apiKey }));
	const models = builtinModels({ credentials });
	const model = models.getModel(options.provider, options.model);
	if (!model) throw new Error(`Unknown model ${options.provider}/${options.model}`);
	const agent = new Agent({
		streamFn: models.streamSimple.bind(models),
		initialState: {
			systemPrompt: options.systemPrompt,
			model,
			thinkingLevel: options.thinkingLevel,
			tools: (options.tools ?? []).map((tool) => adaptTool(tool, options.cwd)),
			messages: (options.history ?? []).map((message) => fromSessionMessage(message, model)),
		},
		...(options.permission
			? {
					beforeToolCall: createPermissionBeforeToolCall({
						context: options.permission,
						...(options.requestBus ? { requestBus: options.requestBus } : {}),
					}),
				}
			: {}),
	});
	return new PiAgentPort(agent, options.requestBus);
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
	const agent = new Agent({
		streamFn: models.streamSimple.bind(models),
		initialState: {
			systemPrompt: "pi contract test",
			model: faux.getModel(),
			thinkingLevel: "off",
			tools: (options.tools ?? []).map((tool) => adaptTool(tool, options.cwd ?? process.cwd())),
		},
		...(options.permission
			? {
					beforeToolCall: createPermissionBeforeToolCall({
						context: options.permission,
						...(options.requestBus ? { requestBus: options.requestBus } : {}),
					}),
				}
			: {}),
	});
	return new PiAgentPort(agent, options.requestBus);
}
