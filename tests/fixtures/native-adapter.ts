import { BaseTextAdapter } from "@tanstack/ai/adapters";
import { EventType } from "@ag-ui/core";
import { type AdapterYieldChunk, type DefaultMessageMetadataByModality, type ModelMessage, type TextOptions } from "@tanstack/ai";
import type { SessionContentBlock, SessionMessage } from "../../packages/protocol/src/index.ts";
import type { Model } from "../../packages/core/src/model-types.ts";

export type NativeRequest = TextOptions<Record<string, unknown>>;
export type NativeStream = (request: NativeRequest) => AsyncIterable<AdapterYieldChunk>;

/** A model-only fixture: production chat owns tools, lifecycle and persistence. */
export function nativeAdapter(model: Model | string, stream: NativeStream) {
	class FixtureAdapter extends BaseTextAdapter<string, Record<string, unknown>, readonly ["text", "image"], DefaultMessageMetadataByModality> {
		readonly name = typeof model === "string" ? "fixture" : model.provider;
		chatStream(request: NativeRequest) { return stream(request); }
		async structuredOutput(): Promise<never> { throw new Error("Fixture uses native chatStream for task and summary requests"); }
	}
	return new FixtureAdapter({}, typeof model === "string" ? model : model.id);
}

/** Test observers inspect the model request, never production internal state. */
export function requestMessages(messages: readonly ModelMessage[]): SessionMessage[] {
	return messages.map(message => {
		const content: SessionContentBlock[] = [];
		for (const part of message.thinking ?? []) content.push({ type: "thinking", thinking: part.content, ...(part.signature ? { thinkingSignature: part.signature } : {}) });
		if (typeof message.content === "string") content.push({ type: "text", text: message.content });
		else for (const part of message.content ?? []) {
			if (part.type === "text") {
				const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata as Record<string, unknown> : undefined;
				const forge = metadata?.forge && typeof metadata.forge === "object" ? metadata.forge as Record<string, unknown> : undefined;
				const textSignature = forge?.textSignature ?? metadata?.textSignature;
				content.push({ type: "text", text: part.content, ...(typeof textSignature === "string" ? { textSignature } : {}) });
			}
			else if (part.type === "image" && part.source.type === "data") content.push({ type: "image", data: part.source.value, mimeType: part.source.mimeType ?? "application/octet-stream" });
		}
		for (const call of message.toolCalls ?? []) content.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments), ...(call.metadata ? { thoughtSignature: JSON.stringify({ forge: "tanstack-tool", version: 1, metadata: call.metadata }) } : {}) });
		return {
			role: message.role === "tool" ? "toolResult" : message.role,
			content, timestamp: message.createdAt?.getTime() ?? 0,
			...(message.role === "assistant" ? { stopReason: message.toolCalls?.length ? "tool_use" as const : "stop" as const } : {}),
			...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
			...(message.name ? { toolName: message.name } : {}),
			...(message.error ? { isError: true } : {}),
		};
	});
}

/** Convert controlled domain answers to the same native chunks a provider emits. */
export function* responseChunks(message: SessionMessage, id = crypto.randomUUID()): Generator<AdapterYieldChunk> {
	for (const [index, part] of message.content.entries()) {
		const messageId = `${id}-${index}`;
		if (part.type === "text") {
			yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
			if (part.text) yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: part.text };
			yield { type: EventType.TEXT_MESSAGE_END, messageId, ...(part.textSignature ? { signature: part.textSignature } : {}) };
		} else if (part.type === "thinking") {
			yield { type: EventType.STEP_STARTED, stepName: "thinking", stepType: "thinking", stepId: messageId };
			if (part.thinking) yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: part.thinking };
			yield { type: EventType.STEP_FINISHED, stepName: "thinking", stepId: messageId, content: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}), ...(part.redacted ? { redacted: true } : {}) };
		} else if (part.type === "tool_call") {
			let metadata: Record<string, unknown> | undefined;
			if (part.thoughtSignature) {
				try { metadata = JSON.parse(part.thoughtSignature).metadata; } catch { metadata = { thoughtSignature: part.thoughtSignature }; }
			}
			yield { type: EventType.TOOL_CALL_START, toolCallId: part.id, toolCallName: part.name, parentMessageId: id, ...(metadata ? { metadata } : {}) };
			yield { type: EventType.TOOL_CALL_ARGS, toolCallId: part.id, delta: JSON.stringify(part.arguments) };
			yield { type: EventType.TOOL_CALL_END, toolCallId: part.id, input: part.arguments };
		}
	}
	const usage = message.usage ? {
		promptTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
		completionTokens: message.usage.output, totalTokens: message.usage.totalTokens,
		promptTokensDetails: { cachedTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite },
		...(message.usage.cost ? { cost: message.usage.cost.total } : {}),
	} : undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		yield { type: EventType.RUN_ERROR, code: message.stopReason === "aborted" ? "aborted" : "fixture_error", message: message.errorMessage ?? (message.stopReason === "aborted" ? "Operation aborted" : "Scripted model error"), ...(usage ? { usage } : {}) };
	} else {
		yield { type: EventType.RUN_FINISHED, threadId: "fixture", runId: id, finishReason: message.stopReason === "tool_use" ? "tool_calls" : message.stopReason === "length" ? "length" : "stop", ...(usage ? { usage } : {}), ...(message.stopReason === "deferred" ? { metadata: { forge: { stopReason: "deferred" } } } : {}) };
	}
}
