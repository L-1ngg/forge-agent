import type { StreamFn, Model } from "../pi-port.ts";
import { clampMaxTokensToContext } from "../session-configuration.ts";
import { toSessionMessage } from "../event-projection.ts";
import { estimateContextTokens } from "../usage.ts";

type Context = Parameters<StreamFn>[1];

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

export function checkRequestBudget(model: Model<string>, context: Context, budget: RequestBudget, revision: number, builtin: boolean): number {
	const input = estimateContextTokens(context.messages.map(message => toSessionMessage(message)!)) + Math.ceil(requestFixedText(context).length / 4);
	const fail = (stage: string): never => {
		throw new Error(`request-budget (${stage}): input=${input}, output=${budget.effectiveOutputTokens}, margin=${REQUEST_MARGIN}, window=${budget.contextWindow}, revision=${revision}${stage === "builtin-output-clamp" ? `, builtinWindow=${model.contextWindow}, builtinMargin=4096` : ""}`);
	};
	if (!Number.isFinite(input) || input > budget.maxInputTokens) fail("general");
	if (builtin && (clampMaxTokensToContext(model, context, budget.maxTokens) < budget.maxTokens || clampMaxTokensToContext(model, context, budget.effectiveOutputTokens) < budget.effectiveOutputTokens)) fail("builtin-output-clamp");
	return input;
}
