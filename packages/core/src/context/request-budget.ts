import type { SessionMessage } from "@forge-agent/protocol";
import type { HarnessTool } from "@forge-agent/tools";
import { estimateContextTokens } from "../usage.ts";
interface Context { systemPrompt?: string; messages: SessionMessage[]; tools?: Array<Pick<HarnessTool<object, unknown>, "name" | "description" | "parameters">>; }

export interface RequestBudget {
	readonly contextWindow: number;
	readonly inputBudget: number;
	readonly maxInputTokens: number;
	readonly fixedTokens: number;
	readonly maxTokens: number;
	readonly effectiveOutputTokens: number;
}

export const REQUEST_MARGIN = 1024;

export function requestFixedText(context: Pick<Context, "systemPrompt" | "tools">): string {
	return (context.systemPrompt ?? "") + JSON.stringify((context.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })));
}

/** Historical usage belongs to history, not to this independently assembled request. */
export function isolateRequest(context: Context): Context {
	const messages = structuredClone(context.messages);
	for (const message of messages) if (message.role === "assistant") message.usage = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return { ...context, messages, ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) })) } : {}) };
}

export function checkRequestBudget(context: Context, budget: RequestBudget, revision: number): number {
	const input = estimateContextTokens(context.messages) + Math.ceil(requestFixedText(context).length / 4);
	if (!Number.isFinite(input) || input > budget.maxInputTokens) throw new Error(`request-budget (general): input=${input}, output=${budget.effectiveOutputTokens}, margin=${REQUEST_MARGIN}, window=${budget.contextWindow}, revision=${revision}`);
	return input;
}
