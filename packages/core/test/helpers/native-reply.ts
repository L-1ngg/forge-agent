import { EventType } from "@ag-ui/core";
import type { AdapterYieldChunk, TextOptions, TokenUsage } from "@tanstack/ai";
import type { Model } from "../../src/model-types.ts";
import { nativeAdapter } from "./native-adapter.ts";

/** Declarative native adapter fixture: no Agent loop, history or model event compatibility. */
export interface NativeReply {
	text?: string;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	usage?: TokenUsage;
	finishReason?: "stop" | "length" | "tool_calls";
	error?: { message: string; code?: string };
	metadata?: Record<string, unknown>;
}

export async function* nativeReply(reply: NativeReply): AsyncIterable<AdapterYieldChunk> {
	if (reply.text !== undefined) {
		yield { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" };
		yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: reply.text };
		yield { type: EventType.TEXT_MESSAGE_END, messageId: "answer" };
	}
	for (const call of reply.toolCalls ?? []) {
		yield { type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name };
		yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: JSON.stringify(call.arguments) };
		yield { type: EventType.TOOL_CALL_END, toolCallId: call.id, input: call.arguments };
	}
	if (reply.error) yield { type: EventType.RUN_ERROR, ...reply.error, ...(reply.usage ? { usage: reply.usage } : {}) };
	else yield {
		type: EventType.RUN_FINISHED, runId: "run", threadId: "thread", ...(reply.usage ? { usage: reply.usage } : {}),
		finishReason: reply.finishReason ?? (reply.toolCalls?.length ? "tool_calls" : "stop"), ...(reply.metadata ? { metadata: reply.metadata } : {}),
	};
}

export function replyAdapter(model: Model | string, respond: (request: TextOptions) => NativeReply | Promise<NativeReply>) {
	return nativeAdapter(model, async function* (request) { yield* nativeReply(await respond(request)); });
}

export function systemText(request: Pick<TextOptions, "systemPrompts">): string {
	return request.systemPrompts?.map(prompt => typeof prompt === "string" ? prompt : prompt.content).join("\n") ?? "";
}
