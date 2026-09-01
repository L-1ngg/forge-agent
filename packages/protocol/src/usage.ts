/** Provider usage values carried across the core/TUI boundary. */
export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: UsageCost;
}

/** Values that a status surface may truthfully display at one render point. */
export interface ContextUsageSnapshot {
	contextTokens?: number;
	contextWindow?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	running?: number;
	contextEstimated?: boolean;
}
