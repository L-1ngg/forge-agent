import type { SessionContentBlock, SessionEvent, SessionMessage, ToolCallBlock } from "@forge-agent/protocol";
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

export function isProviderExecutedCall(call: ToolCallBlock): boolean {
	return toolMetadata(call.thoughtSignature)?.providerExecuted === true;
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
	return messages.flatMap<ModelMessage>(message => {
		if (message.role === "user") return [{ role: "user", content: contentParts(message.content) }];
		if (message.role === "toolResult") return [{
			role: "tool", toolCallId: message.toolCallId ?? "unknown", content: contentParts(message.content),
			...(message.isError ? { error: "Tool execution failed" } : {}),
		}];
		const segments: SessionContentBlock[][] = [[]];
		let providerCallBeforeThinking = false;
		for (const part of message.content) {
			if (part.type === "thinking" && providerCallBeforeThinking) { segments.push([]); providerCallBeforeThinking = false; }
			segments[segments.length - 1]!.push(part);
			if (part.type === "tool_call" && toolMetadata(part.thoughtSignature)?.providerExecuted === true) providerCallBeforeThinking = true;
		}
		return segments.map(blocks => ({
			role: "assistant",
			content: blocks.some(part => part.type === "text" && part.textSignature !== undefined) ? contentParts(blocks) : blocks.filter(part => part.type === "text").map(part => part.text).join(""),
			thinking: blocks.filter(part => part.type === "thinking").map(part => ({ content: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}), ...(part.redacted ? { redacted: true } : {}) })),
			toolCalls: blocks.filter(part => part.type === "tool_call").map(part => {
				const metadata = toolMetadata(part.thoughtSignature);
				return { type: "function" as const, id: part.id, function: { name: part.name, arguments: JSON.stringify(part.arguments) }, ...(metadata ? { metadata } : {}) };
			}),
		}));
	});
}

function usageFor(value: TokenUsage, model: Model, calculate: boolean): NonNullable<SessionMessage["usage"]> {
	const prompt = value.promptTokens ?? 0;
	const output = value.completionTokens ?? 0;
	const cacheRead = value.promptTokensDetails?.cachedTokens ?? 0;
	const cacheWrite = value.promptTokensDetails?.cacheWriteTokens ?? 0;
	// Anthropic and Converse report uncached input separately. Anthropic's
	// normalized total also omits cache tokens; Converse's reported total includes them.
	const uncachedPrompt = model.api === "anthropic-messages" || model.api === "bedrock-converse-stream";
	const input = uncachedPrompt ? prompt : Math.max(0, prompt - cacheRead - cacheWrite);
	const total = input + output + cacheRead + cacheWrite;
	const totalTokens = model.api !== "anthropic-messages" && value.totalTokens !== undefined && value.totalTokens > 0 ? value.totalTokens : total;
	const usage: Usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: zeroUsage().cost };
	if (calculate) { calculateCost(model, usage); return usage; }
	const { cost: _catalogCost, ...tokens } = usage;
	return { ...tokens, ...(value.cost !== undefined ? { cost: { input: value.costDetails?.upstreamInputCost ?? 0, output: value.costDetails?.upstreamOutputCost ?? 0, cacheRead: 0, cacheWrite: 0, total: value.cost } } : {}) };
}

function responseError(chunk: Extract<AdapterYieldChunk, { type: "RUN_ERROR" }>): string {
	const message = chunk.message || chunk.error?.message || "Model response failed";
	if (chunk.code === "incomplete-stream") return `Response stream ended before a terminal response event: ${message}`;
	return /^\d{3}$/.test(chunk.code ?? "") ? `${chunk.code}: ${message}` : message;
}

type ResponsePart =
	| { kind: "text"; id: string; deltas: string[]; length: number; signature?: string }
	| { kind: "thinking"; deltas: string[]; signature?: string; redacted?: boolean }
	| { kind: "tool"; id: string; name: string; raw: string; args?: Record<string, unknown>; metadata?: Record<string, unknown> };

/** Raw protocol guard and failure buffer. Successful content comes from chat()'s ModelMessage. */
export class RawResponseAudit {
	private readonly parts: ResponsePart[] = [];
	private readonly textIndexes = new Map<string, number>();
	private readonly endedTexts = new Set<string>();
	private readonly thinkingIndexes = new Map<string, number>();
	private readonly startedSteps = new Set<string>();
	private readonly finishedSteps = new Set<string>();
	private readonly reasoningStarts = new Set<string>();
	private readonly endedReasoning = new Set<string>();
	private readonly reasoningMessages = new Set<string>();
	private readonly endedReasoningMessages = new Set<string>();
	private readonly toolIndexes = new Map<string, number>();
	private activeReasoningMessageId: string | undefined;
	private currentThinkingId: string | undefined;
	private currentThinkingSource: "step" | "message" | undefined;
	private currentStepFinished = false;
	private terminal = false;
	private lengthErrorTerminal = false;
	private lengthTailFinished = false;
	private started = false;
	private streamError: unknown;
	private tokenUsage: TokenUsage | undefined;
	private stopReason: SessionMessage["stopReason"];
	private errorMessage: string | undefined;
	private readonly timestamp = Date.now();

	constructor(private readonly model: Model, private readonly emit: (event: SessionEvent) => void | Promise<void>, private readonly calculate = true) {}

	private shell(): SessionMessage { return { role: "assistant", content: [], api: this.model.api, provider: this.model.provider, model: this.model.id, timestamp: this.timestamp }; }
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.emit({ type: "message_start", message: this.shell(), timestamp: Date.now() });
	}
	private async delta(index: number, type: "text" | "thinking" | "tool_call", value: string): Promise<void> {
		await this.emit({ type: "message_delta", contentIndex: index, contentType: type, delta: value, timestamp: Date.now() });
	}
	private thinking(id = this.currentThinkingId): { index: number; part: Extract<ResponsePart, { kind: "thinking" }> } | undefined {
		const index = id === undefined ? undefined : this.thinkingIndexes.get(id);
		const part = index === undefined ? undefined : this.parts[index];
		return index !== undefined && part?.kind === "thinking" ? { index, part } : undefined;
	}
	private startThinking(id: string, source: "step" | "message"): void {
		const current = this.thinking();
		const alias = current && this.currentThinkingSource !== source && !this.currentStepFinished;
		if (!this.thinkingIndexes.has(id)) this.thinkingIndexes.set(id, alias ? current.index : this.parts.push({ kind: "thinking", deltas: [] }) - 1);
		this.currentThinkingId = id;
		this.currentThinkingSource = source;
		this.currentStepFinished = false;
	}
	private tool(id: string): { index: number; part: Extract<ResponsePart, { kind: "tool" }> } {
		const index = this.toolIndexes.get(id);
		const part = index === undefined ? undefined : this.parts[index];
		if (index === undefined || part?.kind !== "tool") throw new Error("Model tool event without start");
		return { index, part };
	}
	private captureUsage(chunk: AdapterYieldChunk): void {
		const tanstack = record(record(chunk.metadata)?.tanstack);
		const raw = chunk.usage;
		this.tokenUsage = Array.isArray(raw) ? fromSpecTokenUsage(raw, tanstack?.usage as Parameters<typeof fromSpecTokenUsage>[1]) : record(raw) ? raw as TokenUsage : undefined;
	}
	usage(native?: TokenUsage): SessionMessage["usage"] {
		const value = native ?? this.tokenUsage;
		return value ? usageFor(value, this.model, this.calculate) : this.calculate ? zeroUsage() : undefined;
	}
	get reason(): SessionMessage["stopReason"] { return this.stopReason; }
	get failure(): string | undefined { return this.errorMessage; }
	get hasTools(): boolean { return this.toolIndexes.size > 0; }
	get reportedUsage(): TokenUsage | undefined { return this.tokenUsage; }

	async accept(chunk: AdapterYieldChunk): Promise<void> {
		try {
			await this.start();
			if (this.terminal) {
				// Gemini closes its open blocks and sends RUN_FINISHED after max_tokens.
				if (!this.lengthErrorTerminal || this.lengthTailFinished) throw new Error("Model output after terminal event");
				if (chunk.type === "RUN_FINISHED") {
					const reason = chunk.finishReason ?? record(record(chunk.metadata)?.tanstack)?.finishReason;
					if (reason !== "stop" && reason !== "length") throw new Error(`Unsupported model finish reason: ${reason}`);
					this.lengthTailFinished = true;
					if (chunk.usage !== undefined) this.captureUsage(chunk);
					return;
				}
				if (chunk.type !== "TEXT_MESSAGE_END" && chunk.type !== "REASONING_MESSAGE_END" && chunk.type !== "REASONING_END") throw new Error("Model output after terminal event");
			}
			switch (chunk.type) {
				case "TEXT_MESSAGE_START": {
					if (this.textIndexes.has(chunk.messageId)) throw new Error("Duplicate model text start");
					this.textIndexes.set(chunk.messageId, this.parts.push({ kind: "text", id: chunk.messageId, deltas: [], length: 0 }) - 1);
					break;
				}
				case "TEXT_MESSAGE_CONTENT": {
					const index = this.textIndexes.get(chunk.messageId);
					const part = index === undefined ? undefined : this.parts[index];
					if (index === undefined || part?.kind !== "text" || this.endedTexts.has(chunk.messageId)) throw new Error("Model text delta without active start");
					part.deltas.push(chunk.delta); part.length += chunk.delta.length;
					await this.delta(index, "text", chunk.delta);
					break;
				}
				case "TEXT_MESSAGE_END": {
					const index = this.textIndexes.get(chunk.messageId);
					const part = index === undefined ? undefined : this.parts[index];
					if (!part || part.kind !== "text" || this.endedTexts.has(chunk.messageId)) throw new Error("Model text end without active start");
					this.endedTexts.add(chunk.messageId);
					const signature = chunk.signature ?? record(record(chunk.metadata)?.forge)?.textSignature;
					if (typeof signature === "string") part.signature = signature;
					break;
				}
				case "STEP_STARTED":
					if (chunk.stepId) this.startedSteps.add(chunk.stepId);
					if (chunk.stepType === "thinking") { if (!chunk.stepId) throw new Error("Model reasoning step has no ID"); this.startThinking(chunk.stepId, "step"); }
					break;
				case "REASONING_START":
					if (this.reasoningStarts.has(chunk.messageId)) throw new Error("Duplicate model reasoning start");
					this.reasoningStarts.add(chunk.messageId);
					break;
				case "REASONING_MESSAGE_START":
					if (this.activeReasoningMessageId || this.reasoningMessages.has(chunk.messageId)) throw new Error("Duplicate model reasoning start");
					this.reasoningMessages.add(chunk.messageId);
					this.activeReasoningMessageId = chunk.messageId;
					this.startThinking(chunk.messageId, "message");
					break;
				case "REASONING_MESSAGE_END": {
					if (this.activeReasoningMessageId !== chunk.messageId || !this.thinking()) throw new Error("Model reasoning end without active start");
					this.endedReasoningMessages.add(chunk.messageId);
					this.activeReasoningMessageId = undefined;
					this.currentThinkingId = undefined; this.currentThinkingSource = undefined; this.currentStepFinished = false;
					break;
				}
				case "REASONING_END":
					if (!this.reasoningStarts.has(chunk.messageId) || this.endedReasoning.has(chunk.messageId)) throw new Error("Model reasoning end without active start");
					this.endedReasoning.add(chunk.messageId);
					break;
				case "REASONING_MESSAGE_CONTENT": {
					const thinking = this.thinking();
					// One reasoning message may span multiple provider thinking steps.
					const matches = this.activeReasoningMessageId === undefined ? this.currentThinkingId === chunk.messageId : this.activeReasoningMessageId === chunk.messageId;
					if (!thinking || !matches) throw new Error("Model reasoning delta without active start");
					thinking.part.deltas.push(chunk.delta);
					await this.delta(thinking.index, "thinking", chunk.delta);
					break;
				}
				case "STEP_FINISHED": {
					if (!chunk.stepId || !this.startedSteps.has(chunk.stepId)) throw new Error("Model step finish without start");
					this.finishedSteps.add(chunk.stepId);
					const thinking = this.thinking(chunk.stepId);
					if (!thinking) break;
					const prior = thinking.part.deltas.join("");
					if (typeof chunk.content === "string" && chunk.content.length > prior.length) {
						if (!chunk.content.startsWith(prior)) throw new Error("Model reasoning content changed during streaming");
						const extra = chunk.content.slice(prior.length);
						thinking.part.deltas.push(extra);
						await this.delta(thinking.index, "thinking", extra);
					}
					if (typeof chunk.signature === "string") thinking.part.signature = chunk.signature;
					if ("redacted" in chunk && chunk.redacted === true) thinking.part.redacted = true;
					this.currentStepFinished = true;
					break;
				}
				case "REASONING_ENCRYPTED_VALUE": {
					if (chunk.subtype === "tool-call") this.tool(chunk.entityId).part.metadata = { ...this.tool(chunk.entityId).part.metadata, thoughtSignature: chunk.encryptedValue };
					else { const thinking = this.thinking(chunk.entityId) ?? this.thinking(); if (!thinking) throw new Error("Model encrypted reasoning without start"); thinking.part.signature = chunk.encryptedValue; }
					break;
				}
				case "TOOL_CALL_START": {
					if (this.toolIndexes.has(chunk.toolCallId)) throw new Error("Duplicate model tool call ID");
					const name = chunk.toolCallName ?? chunk.toolName;
					if (!name?.trim()) throw new Error("Model tool call has no name");
					const metadata = record(chunk.metadata);
					this.toolIndexes.set(chunk.toolCallId, this.parts.push({ kind: "tool", id: chunk.toolCallId, name, raw: "", ...(metadata ? { metadata } : {}) }) - 1);
					break;
				}
				case "TOOL_CALL_ARGS": {
					const { index, part } = this.tool(chunk.toolCallId);
					if (part.args) throw new Error("Model tool arguments after completion");
					part.raw = typeof chunk.args === "string" && chunk.args ? chunk.args : part.raw + chunk.delta;
					await this.delta(index, "tool_call", chunk.delta);
					break;
				}
				case "TOOL_CALL_END": {
					const { part } = this.tool(chunk.toolCallId);
					if (part.args) throw new Error("Duplicate model tool end");
					const parsed: unknown = part.raw ? JSON.parse(part.raw) : {};
					const input = chunk.input ?? record(record(chunk.metadata)?.tanstack)?.input ?? parsed;
					const args = record(input);
					if (!args || part.raw && !record(parsed)) throw new Error("Model tool arguments must be an object");
					part.args = structuredClone(args);
					break;
				}
				case "RUN_ERROR":
					this.captureUsage(chunk); this.terminal = true;
					if (chunk.code === "max_tokens" || chunk.code === "incomplete" && chunk.message === "max_output_tokens") { this.stopReason = "length"; this.lengthErrorTerminal = true; }
					else { this.stopReason = chunk.code === "aborted" ? "aborted" : "error"; this.errorMessage = responseError(chunk); }
					break;
				case "RUN_FINISHED": {
					this.captureUsage(chunk);
					const metadata = record(chunk.metadata);
					const reason = chunk.finishReason ?? record(metadata?.tanstack)?.finishReason;
					const deferred = record(metadata?.forge)?.stopReason === "deferred";
					const stopReason = deferred ? "deferred" : reason === "tool_calls" ? "tool_use" : reason === "length" ? "length" : reason === "stop" ? "stop" : undefined;
					if (!stopReason) throw new Error(`Unsupported model finish reason: ${reason}`);
					if (stopReason !== "length" && stopReason !== "deferred" && this.textIndexes.size !== this.endedTexts.size) throw new Error("Model response ended with an incomplete text message");
					if (stopReason !== "length" && stopReason !== "deferred" && this.startedSteps.size !== this.finishedSteps.size) throw new Error("Model response ended with an incomplete step");
					if (stopReason !== "length" && stopReason !== "deferred" && this.reasoningStarts.size !== this.endedReasoning.size) throw new Error("Model response ended with an incomplete reasoning scope");
					if (stopReason !== "length" && stopReason !== "deferred" && this.reasoningMessages.size !== this.endedReasoningMessages.size) throw new Error("Model response ended with an incomplete reasoning message");
					if (stopReason !== "length" && stopReason !== "deferred" && this.parts.some(part => part.kind === "tool" && !part.args)) throw new Error("Model response ended with an incomplete tool call");
					this.terminal = true; this.stopReason = stopReason;
					break;
				}
			}
		} catch (error) { this.streamError ??= error; throw error; }
	}

	/** Terminal remains provisional until the adapter iterator and its finally settle. */
	finish(signal?: AbortSignal, error?: unknown): void {
		const failure = error ?? this.streamError;
		if (signal?.aborted || this.stopReason === "aborted") { this.stopReason = "aborted"; this.errorMessage = "Request aborted"; }
		else if (failure !== undefined || !this.terminal) { this.stopReason = "error"; this.errorMessage = failure === undefined ? "Model stream ended without a terminal event" : failure instanceof Error ? failure.message : String(failure); }
	}

	/** Used only after failure/abort/truncation, never as a successful response. */
	partialMessage(reason = this.stopReason, error = this.errorMessage): SessionMessage {
		const content: SessionContentBlock[] = this.parts.map(part => part.kind === "text" ? { type: "text", text: part.deltas.join(""), ...(part.signature ? { textSignature: part.signature } : {}) }
			: part.kind === "thinking" ? { type: "thinking", thinking: part.deltas.join(""), ...(part.signature ? { thinkingSignature: part.signature } : {}), ...(part.redacted ? { redacted: true } : {}) }
			: { type: "tool_call", id: part.id, name: part.name, arguments: part.args ?? {}, ...(part.metadata ? { thoughtSignature: toolSignature(part.metadata) } : {}) });
		const usage = this.usage();
		return { ...this.shell(), content, ...(reason ? { stopReason: reason } : {}), ...(error ? { errorMessage: error } : {}), ...(usage ? { usage } : {}) };
	}

	/** Project chat's completed messages; raw parts supply only order and missing metadata. */
	project(messages: ModelMessage[], nativeUsage?: TokenUsage): SessionMessage {
		if (!this.terminal || !this.stopReason || ["error", "aborted", "length", "deferred"].includes(this.stopReason)) throw new Error("Model response is not complete");
		const assistants = messages.filter(message => message.role === "assistant");
		if (!assistants.length && this.parts.some(part => part.kind !== "text" || part.length !== 0)) throw new Error("TanStack did not produce an assistant message");
		const text = assistants.flatMap(message => typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.filter(part => part.type === "text").map(part => part.content) : []).join("");
		const thinking = assistants.flatMap(message => message.thinking ?? []);
		const tools = new Map(assistants.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call]));
		const content: SessionContentBlock[] = [];
		let offset = 0, thinkingIndex = 0;
		for (const part of this.parts) {
			if (part.kind === "text") {
				const value = text.slice(offset, offset + part.length); offset += part.length;
				content.push({ type: "text", text: value, ...(part.signature ? { textSignature: part.signature } : {}) });
			} else if (part.kind === "thinking") {
				const value = thinking[thinkingIndex++];
				if (!value) throw new Error("TanStack omitted a reasoning step");
				content.push({ type: "thinking", thinking: value.content, ...(part.signature ?? value.signature ? { thinkingSignature: part.signature ?? value.signature } : {}), ...(part.redacted ? { redacted: true } : {}) });
			} else {
				const call = tools.get(part.id);
				if (!call || call.function.name !== part.name) throw new Error(`TanStack omitted tool call ${part.id}`);
				const args = record(JSON.parse(call.function.arguments));
				if (!args) throw new Error("Model tool arguments must be an object");
				const metadata = { ...part.metadata, ...record(call.metadata) };
				content.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: args, ...(Object.keys(metadata).length ? { thoughtSignature: toolSignature(metadata) } : {}) });
			}
		}
		if (offset !== text.length || thinkingIndex !== thinking.length || content.filter(part => part.type === "tool_call").length !== tools.size) throw new Error("TanStack response differs from the provider event sequence");
		const usage = this.usage(nativeUsage);
		return { ...this.shell(), content, stopReason: this.stopReason, ...(usage ? { usage } : {}) };
	}
}
