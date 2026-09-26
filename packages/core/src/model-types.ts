import type { TSchema } from "typebox";

export type Api = string;
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ThinkingBudgets = Partial<Record<"minimal" | "low" | "medium" | "high", number>>;
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface Model<TApi extends Api = Api> {
	id: string;
	name: string;
	api: TApi;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<"off" | ThinkingLevel, string | null>>;
	samplingParams?: Record<string, unknown>;
	headers?: Record<string, string>;
	compat?: object;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface TextContent { type: "text"; text: string; textSignature?: string }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; thoughtSignature?: string; namespace?: string }

export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	usage: Usage;
	stopReason: StopReason;
	deferred?: { provider: string; modelId: string; api: string; id: string; expiresAt?: number; pollAfterMs?: number; data?: JsonValue };
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
}
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	usage?: Usage;
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | { type: "json_schema"; strict: "prefer" | "require" } | { type: "grammar"; variants: Record<string, string> };
}
export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }

export interface SimpleStreamOptions {
	signal?: AbortSignal;
	apiKey?: string;
	env?: Record<string, string>;
	onPayload?: (payload: unknown, model: Model) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model) => void | Promise<void>;
	maxTokens?: number;
	temperature?: number;
	samplingParams?: Record<string, unknown>;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	cacheRetention?: "none" | "short" | "long";
	sessionId?: string;
	transport?: Transport;
	thinkingBudgets?: ThinkingBudgets;
	toolChoice?: "auto" | "none";
	reasoning?: ThinkingLevel;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	headers?: Record<string, string | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	metadata?: Record<string, unknown>;
}

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message: AssistantMessage }
	| { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
	result(): Promise<AssistantMessage>;
}
