import { calculateCost } from "./model-policy.ts";
import { createAssistantMessageEventStream } from "./model-stream.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "./model-types.ts";
import type { AdapterYieldChunk, ContentPart, ModelMessage, Tool, TokenUsage } from "@tanstack/ai";

export type AdapterStream = (messages: ModelMessage[], tools: Tool[]) => AsyncIterable<AdapterYieldChunk>;

const noUsage = (): Usage => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const toolSignature = (metadata: Record<string, unknown>): string => JSON.stringify({ forge: "tanstack-tool", version: 1, metadata });

function toolMetadata(signature: string | undefined): Record<string, unknown> | undefined {
	if (!signature) return undefined;
	try {
		const value: unknown = JSON.parse(signature);
		if (value && typeof value === "object" && "forge" in value && value.forge === "tanstack-tool" && "version" in value && value.version === 1 && "metadata" in value && value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) return value.metadata as Record<string, unknown>;
		if (value && typeof value === "object" && "forge" in value && value.forge === "openai-responses" && "version" in value && value.version === 1 && "itemId" in value && typeof value.itemId === "string") return { itemId: value.itemId };
	} catch { /* Older providers use opaque signatures. */ }
	return undefined;
}

function contentParts(content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>): string | ContentPart[] {
	if (typeof content === "string") return content;
	return content.map(part => {
		if (part.type === "text") return { type: "text", content: part.text ?? "" };
		if (part.type === "image" && part.data && part.mimeType) return { type: "image", source: { type: "data", value: part.data, mimeType: part.mimeType } };
		throw new Error(`Unsupported model input content: ${part.type}`);
	});
}

function toModelMessages(context: Context): ModelMessage[] {
	return context.messages.map(message => {
		if (message.role === "user") return { role: "user", content: contentParts(message.content) };
		if (message.role === "toolResult") return { role: "tool", toolCallId: message.toolCallId, content: contentParts(message.content), ...(message.isError ? { error: "Tool execution failed" } : {}) };
		return {
			role: "assistant",
			content: message.content.filter(part => part.type === "text").map(part => part.text).join(""),
			thinking: message.content.filter(part => part.type === "thinking").map(part => ({ content: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}), ...(part.redacted ? { redacted: true } : {}) })),
			toolCalls: message.content.filter(part => part.type === "toolCall").map(part => {
				const metadata = toolMetadata(part.thoughtSignature);
				return { type: "function" as const, id: part.id, function: { name: part.name, arguments: JSON.stringify(part.arguments) }, ...(metadata ? { metadata } : {}) };
			}),
		} satisfies ModelMessage;
	});
}

function fromUsage(value: TokenUsage | undefined, model: Model<string>): Usage {
	if (!value) return noUsage();
	const prompt = value.promptTokens ?? 0;
	const output = value.completionTokens ?? 0;
	const cacheRead = value.promptTokensDetails?.cachedTokens ?? 0;
	const cacheWrite = value.promptTokensDetails?.cacheWriteTokens ?? 0;
	const input = model.api === "anthropic-messages" ? prompt : Math.max(0, prompt - cacheRead - cacheWrite);
	const usage: Usage = { input, output, cacheRead, cacheWrite, totalTokens: model.api === "anthropic-messages" ? input + output + cacheRead + cacheWrite : value.totalTokens ?? prompt + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	calculateCost(model, usage);
	return usage;
}

function messageFor(model: Model<string>): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: noUsage(), stopReason: "pending", timestamp: Date.now() };
}

function responseError(chunk: Extract<AdapterYieldChunk, { type: "RUN_ERROR" }>): string {
	const message = chunk.message || chunk.error?.message || "Model response failed";
	if (chunk.code === "incomplete-stream") return `Response stream ended before a terminal response event: ${message}`;
	return /^\d{3}$/.test(chunk.code ?? "") ? `${chunk.code}: ${message}` : message;
}

export function streamTanstack(model: Model<string>, context: Context, options: SimpleStreamOptions, chatStream: AdapterStream) {
	const stream = createAssistantMessageEventStream();
	const result = messageFor(model);
	void (async () => {
		let finished = false;
		const textIndexes = new Map<string, number>();
		const thinkingIndexes = new Map<string, number>();
		const endedThinking = new Set<string>();
		const toolIndexes = new Map<string, number>();
		const endedTools = new Set<string>();
		const toolArgs = new Map<string, string>();
		const fail = (reason: "error" | "aborted", message: string) => {
			if (finished) return;
			finished = true;
			result.stopReason = reason;
			result.errorMessage = message;
			stream.push({ type: "error", reason, error: result });
		};
		try {
			if (options.deferred) throw new Error("Deferred responses are not supported by the TanStack transport");
			options.signal?.throwIfAborted();
			const tools: Tool[] = (context.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
			stream.push({ type: "start", partial: result });
			for await (const chunk of chatStream(toModelMessages(context), tools)) {
				if (finished) break;
				if (options.signal?.aborted) {
					fail("aborted", "Request aborted");
					break;
				}
				switch (chunk.type) {
					case "TEXT_MESSAGE_START": {
						const index = result.content.push({ type: "text", text: "" }) - 1;
						textIndexes.set(chunk.messageId, index);
						stream.push({ type: "text_start", contentIndex: index, partial: result });
						break;
					}
					case "TEXT_MESSAGE_CONTENT": {
						const index = textIndexes.get(chunk.messageId);
						const block = index === undefined ? undefined : result.content[index];
						if (index === undefined || !block || block.type !== "text") throw new Error("Model text delta without start");
						block.text += chunk.delta;
						stream.push({ type: "text_delta", contentIndex: index, delta: chunk.delta, partial: result });
						break;
					}
					case "TEXT_MESSAGE_END": {
						const index = textIndexes.get(chunk.messageId);
						const block = index === undefined ? undefined : result.content[index];
						if (block?.type === "text") stream.push({ type: "text_end", contentIndex: index!, content: block.text, partial: result });
						break;
					}
					case "STEP_STARTED": {
						if (chunk.stepType !== "thinking") break;
						const index = result.content.push({ type: "thinking", thinking: "" }) - 1;
						if (!chunk.stepId) throw new Error("Model reasoning step has no ID");
						thinkingIndexes.set(chunk.stepId, index);
						stream.push({ type: "thinking_start", contentIndex: index, partial: result });
						break;
					}
					case "REASONING_MESSAGE_CONTENT": {
						const index = [...thinkingIndexes.values()].at(-1);
						const block = index === undefined ? undefined : result.content[index];
						if (index === undefined || !block || block.type !== "thinking") throw new Error("Model reasoning delta without start");
						block.thinking += chunk.delta;
						stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk.delta, partial: result });
						break;
					}
				case "STEP_FINISHED": {
						const index = chunk.stepId ? thinkingIndexes.get(chunk.stepId) : undefined;
						const block = index === undefined ? undefined : result.content[index];
						if (block?.type !== "thinking") break;
						if (typeof chunk.content === "string" && chunk.content.length > block.thinking.length) {
							if (!chunk.content.startsWith(block.thinking)) throw new Error("Model reasoning content changed during streaming");
							const delta = chunk.content.slice(block.thinking.length);
							block.thinking += delta;
							stream.push({ type: "thinking_delta", contentIndex: index!, delta, partial: result });
						}
						if ("signature" in chunk && typeof chunk.signature === "string") block.thinkingSignature = chunk.signature;
						if ("redacted" in chunk && chunk.redacted === true) block.redacted = true;
						if (chunk.stepId && !endedThinking.has(chunk.stepId)) {
							endedThinking.add(chunk.stepId);
							stream.push({ type: "thinking_end", contentIndex: index!, content: block.thinking, partial: result });
						}
						break;
					}
					case "TOOL_CALL_START": {
						const metadata = chunk.metadata && typeof chunk.metadata === "object" ? chunk.metadata as Record<string, unknown> : undefined;
						const index = result.content.push({ type: "toolCall", id: chunk.toolCallId, name: chunk.toolCallName, arguments: {}, ...(metadata ? { thoughtSignature: toolSignature(metadata) } : {}) }) - 1;
						toolIndexes.set(chunk.toolCallId, index);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: result });
						break;
					}
					case "TOOL_CALL_ARGS": {
						const index = toolIndexes.get(chunk.toolCallId);
						if (index === undefined) throw new Error("Model tool arguments without start");
						toolArgs.set(chunk.toolCallId, (toolArgs.get(chunk.toolCallId) ?? "") + chunk.delta);
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk.delta, partial: result });
						break;
					}
					case "TOOL_CALL_END": {
						const index = toolIndexes.get(chunk.toolCallId);
						const block = index === undefined ? undefined : result.content[index];
						if (!block || block.type !== "toolCall") throw new Error("Model tool call ended without start");
						const raw = toolArgs.get(chunk.toolCallId);
						if (raw) JSON.parse(raw);
						const args: unknown = chunk.input ?? (raw ? JSON.parse(raw) : {});
						if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Model tool arguments must be an object");
						block.arguments = args as Record<string, unknown>;
						endedTools.add(chunk.toolCallId);
						stream.push({ type: "toolcall_end", contentIndex: index!, toolCall: block, partial: result });
						break;
					}
					case "RUN_ERROR": {
						if ("usage" in chunk && chunk.usage && !Array.isArray(chunk.usage)) result.usage = fromUsage(chunk.usage as TokenUsage, model);
						const reason = options.signal?.aborted || chunk.code === "aborted" ? "aborted" : "error";
						if (chunk.code === "max_tokens" || chunk.code === "incomplete" && chunk.message === "max_output_tokens") {
							result.stopReason = "length";
							finished = true;
							stream.push({ type: "done", reason: "length", message: result });
						} else fail(reason, responseError(chunk));
						break;
					}
					case "RUN_FINISHED": {
						if (endedTools.size !== toolIndexes.size) throw new Error("Model response ended with an incomplete tool call");
						result.usage = fromUsage(Array.isArray(chunk.usage) ? undefined : chunk.usage, model);
						if (chunk.model) result.responseModel = chunk.model;
						const reason = chunk.finishReason === "tool_calls" ? "toolUse" : chunk.finishReason === "length" ? "length" : chunk.finishReason === "stop" ? "stop" : undefined;
						if (!reason) throw new Error(`Unsupported model finish reason: ${chunk.finishReason}`);
						result.stopReason = reason;
						finished = true;
						stream.push({ type: "done", reason, message: result });
						break;
					}
				}
			}
			if (!finished) fail(options.signal?.aborted ? "aborted" : "error", "Model stream ended without a terminal event");
		} catch (error) {
			fail(options.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
		}
	})();
	return stream;
}
