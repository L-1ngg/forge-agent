import type { SessionContentBlock, SessionEvent, SessionMessage, ThinkingBlock, ToolCallBlock } from "@forge-agent/protocol";
import { fromSpecTokenUsage, type AdapterYieldChunk, type ContentPart, type ModelMessage, type TokenUsage } from "@tanstack/ai";
import { calculateCost } from "./model-policy.ts";
import type { Model, Usage } from "./model-types.ts";

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toolSignature = (metadata: Record<string, unknown>): string => JSON.stringify({ forge: "tanstack-tool", version: 1, metadata });

/** Reading these persisted signatures preserves existing JSONL continuation data. */
function toolMetadata(signature: string | undefined): Record<string, unknown> | undefined {
	if (!signature) return undefined;
	try {
		const value = record(JSON.parse(signature));
		if (value?.forge === "tanstack-tool" && value.version === 1) return record(value.metadata);
		if (value?.forge === "openai-responses" && value.version === 1 && typeof value.itemId === "string") return { itemId: value.itemId };
	} catch { /* Historical opaque signatures are not TanStack tool metadata. */ }
	return undefined;
}

function contentParts(blocks: SessionContentBlock[]): ContentPart[] {
	return blocks.flatMap<ContentPart>(part => {
		if (part.type === "text") return [{ type: "text", content: part.text, ...(part.textSignature !== undefined ? { metadata: { forge: { textSignature: part.textSignature } } } : {}) }];
		if (part.type === "image") return [{ type: "image", source: { type: "data", value: part.data, mimeType: part.mimeType } }];
		return [];
	});
}

/** The only history-to-provider projection. Policy filtering happens before it. */
export function toModelMessages(messages: SessionMessage[]): ModelMessage[] {
	return messages.map(message => {
		if (message.role === "user") return { role: "user", content: contentParts(message.content) };
		if (message.role === "toolResult") return {
			role: "tool", toolCallId: message.toolCallId ?? "unknown", content: contentParts(message.content),
			...(message.isError ? { error: "Tool execution failed" } : {}),
		};
		return {
			role: "assistant",
			content: message.content.some(part => part.type === "text" && part.textSignature !== undefined) ? contentParts(message.content) : message.content.filter(part => part.type === "text").map(part => part.text).join(""),
			thinking: message.content.filter(part => part.type === "thinking").map(part => ({ content: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}), ...(part.redacted ? { redacted: true } : {}) })),
			toolCalls: message.content.filter(part => part.type === "tool_call").map(part => {
				const metadata = toolMetadata(part.thoughtSignature);
				return { type: "function" as const, id: part.id, function: { name: part.name, arguments: JSON.stringify(part.arguments) }, ...(metadata ? { metadata } : {}) };
			}),
		};
	});
}

function usageFor(value: TokenUsage, model: Model, calculate: boolean): NonNullable<SessionMessage["usage"]> {
	const prompt = value.promptTokens ?? 0;
	const output = value.completionTokens ?? 0;
	const cacheRead = value.promptTokensDetails?.cachedTokens ?? 0;
	const cacheWrite = value.promptTokensDetails?.cacheWriteTokens ?? 0;
	// Anthropic reports uncached input separately; the other supported adapters
	// report cache hits/writes as part of promptTokens.
	const input = model.api === "anthropic-messages" ? prompt : Math.max(0, prompt - cacheRead - cacheWrite);
	const usage: Usage = { input, output, cacheRead, cacheWrite, totalTokens: model.api === "anthropic-messages" ? input + output + cacheRead + cacheWrite : value.totalTokens ?? prompt + output, cost: zeroUsage().cost };
	if (calculate) { calculateCost(model, usage); return usage; }
	const { cost: _catalogCost, ...tokens } = usage;
	return { ...tokens, ...(value.cost !== undefined ? { cost: { input: value.costDetails?.upstreamInputCost ?? 0, output: value.costDetails?.upstreamOutputCost ?? 0, cacheRead: 0, cacheWrite: 0, total: value.cost } } : {}) };
}

function responseError(chunk: Extract<AdapterYieldChunk, { type: "RUN_ERROR" }>): string {
	const message = chunk.message || chunk.error?.message || "Model response failed";
	if (chunk.code === "incomplete-stream") return `Response stream ended before a terminal response event: ${message}`;
	return /^\d{3}$/.test(chunk.code ?? "") ? `${chunk.code}: ${message}` : message;
}

/** Collect one raw adapter request, before chat() normalizes provider extensions.
 * Its terminal is provisional until finish() observes complete iterator drainage. */
export class ResponseCollector {
	readonly message: SessionMessage;
	private started = false;
	private terminal = false;
	private streamError: unknown;
	private readonly textIndexes = new Map<string, number>();
	private readonly thinkingIndexes = new Map<string, number>();
	private readonly toolIndexes = new Map<string, number>();
	private readonly endedTools = new Set<string>();
	private readonly toolArgs = new Map<string, string>();
	private currentThinkingId: string | undefined;
	private currentThinkingSource: "step" | "message" | undefined;
	private currentStepFinished = false;

	constructor(private readonly model: Model, private readonly emit: (event: SessionEvent) => void | Promise<void>, private readonly options: { calculateCost?: boolean } = {}) {
		this.message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), ...(options.calculateCost === false ? {} : { usage: zeroUsage() }) };
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.emit({ type: "message_start", message: structuredClone(this.message), timestamp: Date.now() });
	}

	private async delta(index: number, type: "text" | "thinking" | "tool_call", delta: string): Promise<void> {
		await this.emit({ type: "message_delta", contentIndex: index, contentType: type, delta, timestamp: Date.now() });
	}

	private startThinking(id: string, source: "step" | "message"): void {
		const current = this.thinking();
		// Providers emit both AG-UI reasoning messages and legacy STEP events,
		// in either order. They are two identities for the same content block.
		const alias = current && this.currentThinkingSource !== source && !this.currentStepFinished;
		if (!this.thinkingIndexes.has(id)) this.thinkingIndexes.set(id, alias ? current.index : this.message.content.push({ type: "thinking", thinking: "" }) - 1);
		this.currentThinkingId = id;
		this.currentThinkingSource = source;
		this.currentStepFinished = false;
	}

	private thinking(id = this.currentThinkingId): { index: number; block: ThinkingBlock } | undefined {
		const index = id === undefined ? undefined : this.thinkingIndexes.get(id);
		const block = index === undefined ? undefined : this.message.content[index];
		return index !== undefined && block?.type === "thinking" ? { index, block } : undefined;
	}

	private tool(id: string): { index: number; block: ToolCallBlock } {
		const index = this.toolIndexes.get(id);
		const block = index === undefined ? undefined : this.message.content[index];
		if (index === undefined || block?.type !== "tool_call") throw new Error("Model tool event without start");
		return { index, block };
	}

	private captureUsage(chunk: AdapterYieldChunk): void {
		const tanstack = record(record(chunk.metadata)?.tanstack);
		const raw = chunk.usage;
		const usage = Array.isArray(raw) ? fromSpecTokenUsage(raw, tanstack?.usage as Parameters<typeof fromSpecTokenUsage>[1]) : record(raw) ? raw as TokenUsage : undefined;
		if (usage) this.message.usage = usageFor(usage, this.model, this.options.calculateCost !== false);
	}

	async accept(chunk: AdapterYieldChunk): Promise<void> {
		try {
			await this.start();
			switch (chunk.type) {
				case "TEXT_MESSAGE_START": {
					if (this.terminal) throw new Error("Model output after terminal event");
					if (this.textIndexes.has(chunk.messageId)) throw new Error("Duplicate model text start");
					this.textIndexes.set(chunk.messageId, this.message.content.push({ type: "text", text: "" }) - 1);
					break;
				}
				case "TEXT_MESSAGE_CONTENT": {
					if (this.terminal) throw new Error("Model output after terminal event");
					const index = this.textIndexes.get(chunk.messageId);
					const block = index === undefined ? undefined : this.message.content[index];
					if (index === undefined || block?.type !== "text") throw new Error("Model text delta without start");
					block.text += chunk.delta;
					await this.delta(index, "text", chunk.delta);
					break;
				}
				case "TEXT_MESSAGE_END": {
					const index = this.textIndexes.get(chunk.messageId);
					const block = index === undefined ? undefined : this.message.content[index];
					const signature = chunk.signature ?? record(record(chunk.metadata)?.forge)?.textSignature;
					if (block?.type === "text" && typeof signature === "string") block.textSignature = signature;
					break;
				}
				case "STEP_STARTED":
					if (chunk.stepType === "thinking") {
						if (!chunk.stepId) throw new Error("Model reasoning step has no ID");
						this.startThinking(chunk.stepId, "step");
					}
					break;
				case "REASONING_MESSAGE_START":
					// Native adapters use STEP_STARTED; custom adapters may use the
					// AG-UI reasoning message lifecycle instead.
					this.startThinking(chunk.messageId, "message");
					break;
				case "REASONING_MESSAGE_END":
					this.currentThinkingId = undefined;
					this.currentThinkingSource = undefined;
					this.currentStepFinished = false;
					break;
				case "REASONING_MESSAGE_CONTENT": {
					const thinking = this.thinking();
					if (!thinking) throw new Error("Model reasoning delta without start");
					thinking.block.thinking += chunk.delta;
					await this.delta(thinking.index, "thinking", chunk.delta);
					break;
				}
				case "STEP_FINISHED": {
					const thinking = this.thinking(chunk.stepId);
					if (!thinking) break;
					if (typeof chunk.content === "string" && chunk.content.length > thinking.block.thinking.length) {
						if (!chunk.content.startsWith(thinking.block.thinking)) throw new Error("Model reasoning content changed during streaming");
						const delta = chunk.content.slice(thinking.block.thinking.length);
						thinking.block.thinking += delta;
						await this.delta(thinking.index, "thinking", delta);
					}
					if (typeof chunk.signature === "string") thinking.block.thinkingSignature = chunk.signature;
					if ("redacted" in chunk && chunk.redacted === true) thinking.block.redacted = true;
					this.currentStepFinished = true;
					break;
				}
				case "REASONING_ENCRYPTED_VALUE": {
					if (chunk.subtype === "tool-call") {
						const { block } = this.tool(chunk.entityId);
						block.thoughtSignature = toolSignature({ ...toolMetadata(block.thoughtSignature), thoughtSignature: chunk.encryptedValue });
					} else {
						const thinking = this.thinking(chunk.entityId) ?? this.thinking();
						if (thinking) thinking.block.thinkingSignature = chunk.encryptedValue;
					}
					break;
				}
				case "TOOL_CALL_START": {
					if (this.terminal) throw new Error("Model tool call after terminal event");
					if (this.toolIndexes.has(chunk.toolCallId)) throw new Error("Duplicate model tool call ID");
					const metadata = record(chunk.metadata);
					const name = chunk.toolCallName ?? chunk.toolName;
					if (!name || !name.trim()) throw new Error("Model tool call has no name");
					this.toolIndexes.set(chunk.toolCallId, this.message.content.push({ type: "tool_call", id: chunk.toolCallId, name, arguments: {}, ...(metadata ? { thoughtSignature: toolSignature(metadata) } : {}) }) - 1);
					break;
				}
				case "TOOL_CALL_ARGS": {
					const { index } = this.tool(chunk.toolCallId);
					if (this.endedTools.has(chunk.toolCallId)) throw new Error("Model tool arguments after completion");
					this.toolArgs.set(chunk.toolCallId, typeof chunk.args === "string" && chunk.args ? chunk.args : (this.toolArgs.get(chunk.toolCallId) ?? "") + chunk.delta);
					await this.delta(index, "tool_call", chunk.delta);
					break;
				}
				case "TOOL_CALL_END": {
					const { block } = this.tool(chunk.toolCallId);
					const raw = this.toolArgs.get(chunk.toolCallId);
					const parsed: unknown = raw ? JSON.parse(raw) : {};
					const tanstack = record(record(chunk.metadata)?.tanstack);
					const input = chunk.input ?? tanstack?.input ?? parsed;
					const args = record(input);
					if (!args || raw && !record(parsed)) throw new Error("Model tool arguments must be an object");
					block.arguments = structuredClone(args);
					this.endedTools.add(chunk.toolCallId);
					break;
				}
				case "RUN_ERROR":
					this.captureUsage(chunk);
					this.terminal = true;
					if (chunk.code === "max_tokens" || chunk.code === "incomplete" && chunk.message === "max_output_tokens") this.message.stopReason = "length";
					else {
						this.message.stopReason = chunk.code === "aborted" ? "aborted" : "error";
						this.message.errorMessage = responseError(chunk);
					}
					break;
				case "RUN_FINISHED": {
					if (this.terminal) throw new Error("Duplicate model terminal event");
					this.captureUsage(chunk);
					const metadata = record(chunk.metadata);
					const reason = chunk.finishReason ?? record(metadata?.tanstack)?.finishReason;
					const deferred = record(metadata?.forge)?.stopReason === "deferred";
					const stopReason = deferred ? "deferred" : reason === "tool_calls" ? "tool_use" : reason === "length" ? "length" : reason === "stop" ? "stop" : undefined;
					if (!stopReason) throw new Error(`Unsupported model finish reason: ${reason}`);
					if (stopReason !== "length" && this.endedTools.size !== this.toolIndexes.size) throw new Error("Model response ended with an incomplete tool call");
					this.terminal = true;
					this.message.stopReason = stopReason;
					break;
				}
			}
		} catch (error) {
			this.streamError ??= error;
			throw error;
		}
	}

	/** Call only after the adapter iterable and its finally blocks have settled. */
	finish(signal?: AbortSignal, error?: unknown): SessionMessage {
		const failure = error ?? this.streamError;
		if (signal?.aborted || this.message.stopReason === "aborted") {
			this.message.stopReason = "aborted";
			this.message.errorMessage = "Request aborted";
		} else if (failure !== undefined || !this.terminal) {
			this.message.stopReason = "error";
			this.message.errorMessage = failure === undefined ? "Model stream ended without a terminal event" : failure instanceof Error ? failure.message : String(failure);
		}
		return this.message;
	}
}
