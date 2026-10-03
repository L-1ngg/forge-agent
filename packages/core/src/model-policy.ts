import type { SessionMessage } from "@forge-agent/protocol";
import type { Model, ThinkingLevel, Usage } from "./model-types.ts";

const thinkingBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function adjustMaxTokensForThinking(baseMaxTokens: number | undefined, modelMaxTokens: number, level: ThinkingLevel, custom?: Partial<typeof thinkingBudgets>) {
	const key = level === "xhigh" || level === "max" ? "high" : level;
	let thinkingBudget = { ...thinkingBudgets, ...custom }[key];
	const maxTokens = baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
	if (maxTokens <= thinkingBudget) thinkingBudget = Math.min(thinkingBudget, Math.max(0, maxTokens - 1024));
	return { maxTokens, thinkingBudget };
}

export function calculateCost(model: Model, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const tier = model.cost.tiers?.filter(item => inputTokens > item.inputTokensAbove).sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
	const rates = tier ?? model.cost;
	const longWrite = usage.cacheWrite1h ?? 0;
	usage.cost.input = rates.input * usage.input / 1_000_000;
	usage.cost.output = rates.output * usage.output / 1_000_000;
	usage.cost.cacheRead = rates.cacheRead * usage.cacheRead / 1_000_000;
	usage.cost.cacheWrite = (rates.cacheWrite * (usage.cacheWrite - longWrite) + rates.input * 2 * longWrite) / 1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

export function getSupportedThinkingLevels(model: Model): Array<(typeof thinkingLevels)[number]> {
	if (!model.reasoning) return ["off"];
	return thinkingLevels.filter(level => model.thinkingLevelMap?.[level] !== null && (level !== "xhigh" && level !== "max" || model.thinkingLevelMap?.[level] !== undefined));
}

const overflowPatterns = [
	/prompt is too long/i, /request_too_large/i, /input is too long for requested model/i,
	/exceeds (?:the )?(?:model'?s )?(?:maximum )?context (?:window|length)/i,
	/input token count.*exceeds the maximum/i, /maximum prompt length is \d+/i,
	/reduce the length of the messages/i, /maximum allowed input length/i,
	/context window exceeds limit/i, /exceeded model token limit/i,
	/exceeds the available context size/i, /greater than the context length/i,
	/too large for model with \d+ maximum context length/i, /model_context_window_exceeded/i,
	/prompt too long/i, /range of input length should be/i, /context[_ ]length[_ ]exceeded/i,
	/too many tokens/i, /token limit exceeded/i, /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];
const nonOverflow = /^(Throttling error|Service unavailable):|rate limit|too many requests/i;

export function isContextOverflow(message: Pick<SessionMessage, "stopReason" | "errorMessage" | "usage">, contextWindow?: number): boolean {
	if (message.stopReason === "error" && message.errorMessage && !nonOverflow.test(message.errorMessage) && overflowPatterns.some(pattern => pattern.test(message.errorMessage!))) return true;
	if (!contextWindow || message.stopReason !== "stop" && message.stopReason !== "length") return false;
	const input = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0);
	return message.stopReason === "stop" && input > contextWindow || message.stopReason === "length" && message.usage?.output === 0 && input >= contextWindow * 0.99;
}

const nonRetryable = /GoUsageLimitError|FreeUsageLimitError|monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const retryable = /overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|524)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

export function isRetryableAssistantError(message: Pick<SessionMessage, "stopReason" | "errorMessage" | "usage">): boolean {
	return message.stopReason === "error" && !!message.errorMessage && !nonRetryable.test(message.errorMessage) && retryable.test(message.errorMessage);
}
