import { expect, test } from "bun:test";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { getCatalogModel } from "../src/model-catalog.ts";
import { processConverseStream } from "../node_modules/@tanstack/ai-bedrock/dist/esm/converse/stream-processor.js";
import { toConverseMessages } from "../node_modules/@tanstack/ai-bedrock/dist/esm/converse/message-converter.js";
import { collectResponse } from "./helpers/native-request.ts";
import { toModelMessages } from "../src/model-response.ts";

const model = getCatalogModel("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0")!;

function converseEvents(complete = true) {
	return (async function* (): AsyncGenerator<ConverseStreamOutput> {
		yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "reason" } } } };
		yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed-reason" } } } };
		if (!complete) return;
		yield { contentBlockStop: { contentBlockIndex: 0 } };
		yield { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } } } };
		yield { contentBlockStop: { contentBlockIndex: 1 } };
		yield { messageStop: { stopReason: "end_turn" } };
	})();
}

test("Bedrock reasoning text and redacted signature reach Forge output and Converse history", async () => {
	let nextId = 0;
	const response = await collectResponse(model, processConverseStream(converseEvents(), () => `id_${++nextId}`));
	expect(response.stopReason).toBe("stop");
	expect(response.content).toEqual([
		{ type: "thinking", thinking: "reason", thinkingSignature: "signed-reason" },
		{ type: "thinking", thinking: "", thinkingSignature: "AQID", redacted: true },
	]);
	const [message] = toConverseMessages(toModelMessages([response])).messages;
	expect(message?.content).toEqual([
		{ reasoningContent: { reasoningText: { text: "reason", signature: "signed-reason" } } },
		{ reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
	]);
});

test("Bedrock rejects incomplete reasoning and preserves failed tool status", async () => {
	let nextId = 0;
	const response = await collectResponse(model, processConverseStream(converseEvents(false), () => `id_${++nextId}`));
	expect(response.stopReason).toBe("error");
	const messages = toConverseMessages([{ role: "tool", toolCallId: "call_1", content: "failed", error: "Tool execution failed" }]).messages;
	expect(messages[0]?.content).toEqual([{ toolResult: { toolUseId: "call_1", content: [{ text: "failed" }], status: "error" } }]);
});
