import type { AnyBlockEnvelope } from "./blocks.ts";
import type { TokenUsage } from "./usage.ts";

export type SessionRole = "user" | "assistant" | "toolResult";

export type StopReason = "stop" | "length" | "tool_use" | "error" | "aborted" | "deferred";

export interface TextBlock {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ToolCallBlock {
	type: "tool_call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
	namespace?: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type SessionContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

export interface SessionMessage {
	role: SessionRole;
	content: SessionContentBlock[];
	timestamp: number;
	toolCallId?: string;
	toolName?: string;
	/** Tool display payload; never converted into model content. */
	details?: unknown;
	isError?: boolean;
	provider?: string;
	model?: string;
	api?: string;
	usage?: TokenUsage;
	stopReason?: StopReason;
	errorMessage?: string;
	/** Failed length attempt selected for context recovery; retained only in raw history. */
	contextExcluded?: boolean;
}

interface EventBase {
	timestamp: number;
}

export type SessionEvent =
	| (EventBase & { type: "configuration"; phase: "accepted" | "applied"; revision: number })
	| (EventBase & { type: "retry"; phase: "scheduled" | "attempt" | "end"; attempt: number; delayMs?: number; error?: string; outcome?: "success" | "error" | "aborted" })
	| (EventBase & { type: "compaction"; phase: "start" | "end" | "error" | "skipped" | "retry" | "attempt"; operationId: string; reason: string; beforeTokens: number; afterTokens?: number; error?: string; attempt?: number; delayMs?: number; thinking?: string; usage?: TokenUsage })
	| (EventBase & { type: "recovery"; operationId: string; reason: string; attempt: number })
	| (EventBase & { type: "agent_start" })
	| (EventBase & { type: "agent_end"; outcome?: "success" | "error" | "aborted" | "length" | "deferred" })
	| (EventBase & { type: "turn_start" })
	| (EventBase & { type: "turn_end"; stopReason?: StopReason })
	| (EventBase & { type: "message_start"; message: SessionMessage })
	| (EventBase & {
			type: "message_delta";
			contentIndex: number;
			contentType: "text" | "thinking" | "tool_call";
			delta: string;
	  })
	| (EventBase & { type: "message_end"; message: SessionMessage })
	| (EventBase & {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			block?: AnyBlockEnvelope;
	  })
	| (EventBase & {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			content: string;
			block?: AnyBlockEnvelope;
	  })
	| (EventBase & {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			content: string;
			isError: boolean;
			block?: AnyBlockEnvelope;
	  });

export function sessionEvent<T extends SessionEvent>(event: T): T {
	return event;
}
