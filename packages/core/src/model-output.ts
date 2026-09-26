import type { Model } from "./model-types.ts";
import { adjustMaxTokensForThinking } from "./model-policy.ts";

export function isBedrockClaude(model: Model<string>): boolean {
	return [model.id, model.name].some(value => /anthropic[./]claude/i.test(value)) || /claude/i.test(model.name);
}

export function usesAdaptiveThinking(model: Model<string>): boolean {
	if (model.api !== "bedrock-converse-stream") return (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
	const names = [model.id, model.name].flatMap(value => [value.toLowerCase(), value.toLowerCase().replace(/[\s_.:]+/g, "-")]);
	return names.some(value => ["opus-4-6", "opus-4-7", "opus-4-8", "opus-5", "sonnet-4-6", "sonnet-5", "fable-5"].some(name => value.includes(name)));
}

/** Provider thinking tokens share the response ceiling for older Claude models. */
export function effectiveOutputTokens(model: Model<string>, requested: number, reasoning: string): number {
	const budgeted = model.api === "anthropic-messages" || (model.api === "bedrock-converse-stream" && isBedrockClaude(model));
	return budgeted && reasoning !== "off" && !usesAdaptiveThinking(model)
		? adjustMaxTokensForThinking(requested, model.maxTokens, reasoning as "minimal" | "low" | "medium" | "high" | "xhigh" | "max").maxTokens
		: requested;
}
