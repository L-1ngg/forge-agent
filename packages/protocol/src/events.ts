import type { AnyBlockEnvelope } from "./blocks.ts";

export type SessionRole = "user" | "assistant" | "toolResult";

export type StopReason = "stop" | "length" | "tool_use" | "error" | "aborted" | "deferred";

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface ToolCallBlock {
	type: "tool_call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type SessionContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface SessionMessage {
	role: SessionRole;
	content: SessionContentBlock[];
	timestamp: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	provider?: string;
	model?: string;
	api?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
	};
	stopReason?: StopReason;
	errorMessage?: string;
}

interface EventBase {
	timestamp: number;
}

export type SessionEvent =
	| (EventBase & { type: "agent_start" })
	| (EventBase & { type: "agent_end" })
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
