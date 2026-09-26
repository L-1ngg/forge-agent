import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { createOpenaiChat, type OpenAIChatModel } from "@tanstack/ai-openai";
import type { StreamFn } from "./runtime/types.ts";
import { streamTanstack } from "./tanstack-stream.ts";

export const openaiStream: StreamFn = (model, context, options = {}) => streamTanstack(model, context, options, (messages, tools) => {
	if (model.provider !== "openai" || model.api !== "openai-responses") throw new Error("OpenAI stream requires an OpenAI Responses model");
	const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OpenAI API key is not configured");
	const adapter = createOpenaiChat(model.id as OpenAIChatModel, apiKey, { baseURL: model.baseUrl, maxRetries: 0 });
	return adapter.chatStream({
		model: model.id,
		messages,
		...(context.systemPrompt ? { systemPrompts: [{ content: context.systemPrompt }] } : {}),
		tools,
		modelOptions: { store: false, ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}), ...(options.reasoning ? { reasoning: { effort: options.reasoning } } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) },
		...(options.signal ? { request: { signal: options.signal } } : {}),
		logger: resolveDebugOption(false),
	});
});
