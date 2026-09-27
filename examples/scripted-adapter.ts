import { BaseTextAdapter } from "@tanstack/ai/adapters";
import type { AdapterYieldChunk, DefaultMessageMetadataByModality, TextOptions } from "@tanstack/ai";
import { EventType } from "@ag-ui/core";
import type { Model } from "../packages/core/src/sdk.ts";

interface Reply {
	text?: string;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

/** A local native TanStack adapter. Forge and chat() still own the real execution path. */
export function scriptedResponses(responses: Reply[], observe?: (request: TextOptions) => void | Promise<void>) {
	const model: Model = {
		id: "script", name: "script", provider: "script", api: "faux", baseUrl: "", reasoning: false,
		input: ["text"], contextWindow: 100000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let index = 0;
	class ScriptedAdapter extends BaseTextAdapter<string, Record<string, unknown>, readonly ["text"], DefaultMessageMetadataByModality> {
		readonly name = "script";
		async *chatStream(request: TextOptions): AsyncIterable<AdapterYieldChunk> {
			request.request?.signal?.throwIfAborted();
			await observe?.(request);
			const reply = responses[index++];
			if (!reply) throw new Error("No scripted response remains");
			const messageId = `reply-${index}`;
			if (reply.text !== undefined) {
				yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
				yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: reply.text };
				yield { type: EventType.TEXT_MESSAGE_END, messageId };
			}
			for (const call of reply.toolCalls ?? []) {
				yield { type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name };
				yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: JSON.stringify(call.arguments) };
				yield { type: EventType.TOOL_CALL_END, toolCallId: call.id, input: call.arguments };
			}
			yield {
				type: EventType.RUN_FINISHED, threadId: "script", runId: messageId,
				finishReason: reply.toolCalls?.length ? "tool_calls" : "stop",
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
			};
		}
		async structuredOutput(): Promise<never> { throw new Error("This example uses chatStream only"); }
	}
	return { model, adapter: new ScriptedAdapter({}, model.id) };
}
