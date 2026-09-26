import { createAssistantMessageEventStream } from "../packages/core/src/model-stream.ts";
import type { AssistantMessage, Model } from "../packages/core/src/model-types.ts";
import type { StreamFn } from "../packages/core/src/sdk.ts";

export function scriptedResponses(responses: Array<AssistantMessage["content"]>): { model: Model; streamFn: StreamFn } {
	const model: Model = {
		id: "script", name: "script", provider: "script", api: "script", baseUrl: "", reasoning: false,
		input: ["text"], contextWindow: 100000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let index = 0;
	const streamFn: StreamFn = (_model, _context, options) => {
		options?.signal?.throwIfAborted();
		const content = responses[index++];
		if (!content) throw new Error("No scripted response remains");
		const response: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
			content, stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: response });
		for (const [contentIndex, block] of content.entries()) {
			if (block.type === "text") stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: response });
			else if (block.type === "thinking") stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: response });
			else stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: response });
		}
		stream.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response });
		return stream;
	};
	return { model, streamFn };
}
