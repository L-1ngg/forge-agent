import type { ContextUsageSnapshot, SessionMessage, TokenUsage } from "@forge-agent/protocol";

export interface ContextAssembly {
	identity?: string;
	fixedText?: string;
	messages?: readonly SessionMessage[];
	/** Exact count from the provider/request builder when available. */
	contextTokens?: number;
	contextWindow?: number;
	/** Optional deterministic counter for a provider-specific assembled context. */
	tokenCounter?: (messages: readonly SessionMessage[]) => number | undefined;
	/** Usage from the request associated with this assembled context. */
	usage?: TokenUsage;
	running?: number;
}

export interface UsageTruthPoint extends ContextUsageSnapshot {
	/** True when contextTokens came from the local fallback counter. */
	contextEstimated?: boolean;
}

export interface UsageTrackerOptions {
	contextWindow?: number;
	tokenCounter?: (messages: readonly SessionMessage[]) => number | undefined;
}

/**
 * Calculate usage from the context currently being assembled. Explicit context
 * counts win over any previous provider response, which prevents a stale
 * last-call snapshot from being presented as the current context.
 */
export function calculateContextUsage(context: ContextAssembly | readonly SessionMessage[], options: UsageTrackerOptions = {}): UsageTruthPoint {
	const assembly: ContextAssembly = isMessageList(context) ? { messages: context } : context;
	const messages = assembly.messages ?? [];
	const usage = assembly.usage ?? latestUsage(messages);
	const result: UsageTruthPoint = {};
	const explicitTokens = finiteNonNegative(assembly.contextTokens);
	if (explicitTokens !== undefined) result.contextTokens = explicitTokens;
	else {
		const counted = assembly.tokenCounter?.(messages) ?? options.tokenCounter?.(messages);
		const count = finiteNonNegative(counted);
		if (count !== undefined) result.contextTokens = count;
		else if (messages.length > 0 || assembly.fixedText) {
			result.contextTokens = estimateContextTokens(messages) + estimateTextTokens(assembly.fixedText ?? "");
			result.contextEstimated = true;
		}
	}
	const contextWindow = finitePositive(assembly.contextWindow ?? options.contextWindow);
	if (contextWindow !== undefined) result.contextWindow = contextWindow;
	if (usage) Object.assign(result, usageSnapshot(usage));
	return result;
}

export const usageAtTruthPoint = calculateContextUsage;
export const contextUsage = calculateContextUsage;

/** Mutable adapter for runtimes that assemble context over several events. */
export class UsageTracker {
	private context: ContextAssembly = {};
	private latest: TokenUsage | undefined;
	private runningCount = 0;
	private readonly options: UsageTrackerOptions;
	private anchor: { prefix: string; length: number; identity: string | undefined; tokens: number } | undefined;

	constructor(options: UsageTrackerOptions = {}) {
		this.options = { ...options };
	}

	setContext(context: ContextAssembly | readonly SessionMessage[]): void {
		this.context = isMessageList(context) ? { messages: context } : { ...context };
		if (this.anchor && (this.anchor.identity !== this.context.identity || this.anchor.prefix !== JSON.stringify((this.context.messages ?? []).slice(0, this.anchor.length)))) this.invalidate();
		if (!isMessageList(context) && context.usage) this.latest = cloneUsage(context.usage);
	}

	updateContext(context: ContextAssembly | readonly SessionMessage[]): void {
		this.setContext(context);
	}

	recordUsage(usage: TokenUsage): void {
		this.latest = cloneUsage(usage);
		const messages = this.context.messages ?? [];
		const last = messages.at(-1);
		const tokens = usageTokens(usage);
		if (last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted" && tokens > 0) {
			this.anchor = { prefix: JSON.stringify(messages), length: messages.length, identity: this.context.identity, tokens };
		}
	}
	invalidate(): void { this.anchor = undefined; }

	record(usage: TokenUsage): void {
		this.recordUsage(usage);
	}

	beginTurn(): void {
		this.runningCount++;
	}

	start(): void {
		this.beginTurn();
	}

	endTurn(): void {
		this.runningCount = Math.max(0, this.runningCount - 1);
	}

	finish(): void {
		this.endTurn();
	}

	setRunning(count: number): void {
		if (!Number.isFinite(count) || count < 0) throw new RangeError("running count must be a non-negative finite number");
		this.runningCount = Math.floor(count);
	}

	snapshot(): UsageTruthPoint {
		const snapshot = calculateContextUsage(
			{ ...this.context, ...(this.latest ? { usage: this.latest } : {}) },
			this.options,
		);
		if (this.anchor && this.context.contextTokens === undefined && !this.context.tokenCounter) {
			const trailing = (this.context.messages ?? []).slice(this.anchor.length);
			snapshot.contextTokens = this.anchor.tokens + estimateContextTokens(trailing);
			snapshot.contextEstimated = trailing.length > 0;
		}
		if (this.runningCount > 0 || this.context.running !== undefined) snapshot.running = this.context.running ?? this.runningCount;
		return snapshot;
	}

	getSnapshot(): UsageTruthPoint {
		return this.snapshot();
	}
}

function usageSnapshot(usage: TokenUsage): ContextUsageSnapshot {
	const snapshot: ContextUsageSnapshot = {};
	if (finiteNonNegative(usage.input) !== undefined) snapshot.inputTokens = usage.input;
	if (finiteNonNegative(usage.output) !== undefined) snapshot.outputTokens = usage.output;
	if (finiteNonNegative(usage.cacheRead) !== undefined) snapshot.cacheReadTokens = usage.cacheRead;
	if (finiteNonNegative(usage.cacheWrite) !== undefined) snapshot.cacheWriteTokens = usage.cacheWrite;
	if (finiteNonNegative(usage.totalTokens) !== undefined) snapshot.totalTokens = usage.totalTokens;
	const cost = finiteNonNegative(usage.cost?.total);
	if (cost !== undefined) snapshot.costUsd = cost;
	return snapshot;
}

function latestUsage(messages: readonly SessionMessage[]): TokenUsage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.usage && usageTokens(message.usage) > 0) return message.usage;
	}
	return undefined;
}

export function usageTokens(usage: TokenUsage): number {
	return finitePositive(usage.totalTokens) ?? [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, value) => sum + (finiteNonNegative(value) ?? 0), 0);
}

/** Character heuristic, not an upper bound or exact tokenizer. */
export function estimateContextTokens(messages: readonly SessionMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += 1;
		for (const block of message.content) {
			if (block.type === "text") total += estimateTextTokens(block.text);
			else if (block.type === "thinking") total += estimateTextTokens(block.thinking);
			else if (block.type === "image") total += 1024;
			else total += estimateTextTokens(`${block.name} ${JSON.stringify(block.arguments)}`);
		}
	}
	return total;
}

function estimateTextTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

function cloneUsage(usage: TokenUsage): TokenUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		...(usage.cost ? { cost: { ...usage.cost } } : {}),
	};
}

function finiteNonNegative(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositive(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isMessageList(value: ContextAssembly | readonly SessionMessage[]): value is readonly SessionMessage[] {
	return Array.isArray(value);
}
