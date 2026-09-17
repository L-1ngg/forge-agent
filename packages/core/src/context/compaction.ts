import type { SessionMessage, TokenUsage } from "@forge-agent/protocol";
import { selectedBranch, type SessionState } from "../session-storage.ts";
import { compactedMessages } from "./compact.ts";

export interface ContextSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; summaryReasoning: "inherit" | "off"; }
export const DEFAULT_CONTEXT: ContextSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, summaryReasoning: "inherit" };
export interface RetryPolicy { enabled: boolean; maxRetries: number; baseDelayMs: number; }
export const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };
export function resolveRetryPolicy(settings: Partial<RetryPolicy> = {}): RetryPolicy {
	const policy = { ...DEFAULT_RETRY, ...settings };
	if (typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0 || !Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) throw new Error("Invalid retry settings");
	return policy;
}

export function validateRequestLimits(options: { maxTokens?: number; contextWindow?: number }): void {
	for (const key of ["maxTokens", "contextWindow"] as const) {
		if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! <= 0)) throw new Error(`Invalid ${key}: expected a positive safe integer`);
	}
}
export type CompactionReason = "manual" | "threshold" | "overflow" | "length" | "usage";
export interface CompactionResult { status: "complete" | "skipped" | "error"; operationId: string; beforeTokens: number; afterTokens?: number; error?: string; }
export interface SummaryRequest { prompt: string; maxTokens: number; reasoning: "inherit" | "off"; }
export interface SummaryDriver {
	maxTokens?: number;
	outputTokens?(requested: number, reasoning: "inherit" | "off"): number;
	retry?: Partial<RetryPolicy>;
	isRetryable?(message: SessionMessage): boolean;
	wait?(ms: number, signal: AbortSignal): Promise<void>;
	summarize?(request: SummaryRequest, signal: AbortSignal): Promise<SessionMessage>;
}
export function buildContext(state: SessionState): SessionMessage[] {
	const branch = selectedBranch(state);
	if ([...branch].reverse().find(entry => entry.type === "compaction")?.checkpoint) return compactedMessages(state);
	return structuredClone(branch.flatMap(entry => entry.type === "message" ? [entry.message] : []));
}

export const SUMMARY_SYSTEM = "You are a context summarization assistant. Summarize the conversation provided inside the conversation tags. Do not continue the conversation or respond to questions in it. Output only the structured summary.";
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const aborted = () => { clearTimeout(timer); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
		signal.addEventListener("abort", aborted, { once: true });
	});
}

export function sumUsage(usages: readonly TokenUsage[]): TokenUsage {
	return usages.reduce<TokenUsage>((total, usage) => ({
		input: total.input + usage.input, output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: { input: (total.cost?.input ?? 0) + (usage.cost?.input ?? 0), output: (total.cost?.output ?? 0) + (usage.cost?.output ?? 0), cacheRead: (total.cost?.cacheRead ?? 0) + (usage.cost?.cacheRead ?? 0), cacheWrite: (total.cost?.cacheWrite ?? 0) + (usage.cost?.cacheWrite ?? 0), total: (total.cost?.total ?? 0) + (usage.cost?.total ?? 0) },
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
}
