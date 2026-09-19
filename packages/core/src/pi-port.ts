import { snapshotConfiguration, prepareSessionConfiguration, createSummaryDriver } from "./session-configuration.ts";
import type { ConfigurationPatch } from "./configuration.ts";
import type { AgentOptions as RuntimeOptions } from "./runtime/agent.ts";
import { toPiStopReason } from "./event-projection.ts";
import { AgentSession } from "./agent-session.ts";
import {
	type AssistantMessageEventStream,
	type Context,
	type SimpleStreamOptions,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionMessage, StopReason } from "@forge-agent/protocol";
import { type HarnessTool, type ToolInputRewrite } from "@forge-agent/tools";
import type { PermissionContext } from "./permission/index.ts";
import type { AgentPort, InputQueueOptions } from "./agent-port.ts";
import type { RequestBus } from "./request-bus.ts";
import type { ContextSettings, RetryPolicy } from "./context/compaction.ts";
import type { MemoryOptions } from "./memory/tools.ts";

export type ToolHooks = Pick<RuntimeOptions, "beforeToolCall" | "afterToolCall" | "toolExecution">;

export interface PiPortOptions extends InputQueueOptions {
	memory?: MemoryOptions;
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
	memory?: MemoryOptions;
	toolHooks?: ToolHooks;
	responses: PiTestResponse[];
	tools?: Array<HarnessTool<object, unknown>>;
	/** Rewrite tool input before execution; permission checks observe the rewritten object. */
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	cwd?: string;
	tokensPerSecond?: number;
	requestBus?: RequestBus;
	permission?: PermissionContext;
}

export interface ModelPortOptions extends InputQueueOptions {
	memory?: MemoryOptions;
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

/** Assemble the single source-owned session runtime. */
export async function createPiPort(options: PiPortOptions): Promise<AgentPort> {
	let desired = snapshotConfiguration(options);
	const initial = await prepareSessionConfiguration(desired);
	return new AgentSession(initial, async (patch: ConfigurationPatch) => {
		const next = snapshotConfiguration({ ...desired, ...patch });
		const assembly = await prepareSessionConfiguration(next);
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
	const assembly = { options: configured, driver: createSummaryDriver(configured) };
	return new AgentSession(assembly, async () => { throw new Error("Scripted provider does not support model reconfiguration"); });
}
