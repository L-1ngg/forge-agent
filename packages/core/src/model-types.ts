export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Model<TApi extends string = string> {
	id: string;
	name: string;
	api: TApi;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<"off" | ThinkingLevel, string | null>>;
	samplingParams?: Record<string, unknown>;
	headers?: Record<string, string>;
	compat?: object;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
