import { expect, test } from "bun:test";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { EventType } from "@tanstack/ai";
import { getCatalogModel } from "../src/model-catalog.ts";
import { processConverseStream } from "../node_modules/@tanstack/ai-bedrock/dist/esm/converse/stream-processor.js";
import { toConverseMessages } from "../node_modules/@tanstack/ai-bedrock/dist/esm/converse/message-converter.js";
import { collectResponse } from "../../../tests/fixtures/native-request.ts";
import { RawResponseAudit, toModelMessages } from "../src/model-response.ts";

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

test("Bedrock reasoning content spans steps under one reasoning message ID", async () => {
	let nextId = 0;
	const events = (async function* (): AsyncGenerator<ConverseStreamOutput> {
		yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "first" } } } };
		yield { contentBlockStop: { contentBlockIndex: 0 } };
		yield { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { text: "second" } } } };
		yield { contentBlockStop: { contentBlockIndex: 1 } };
		yield { messageStop: { stopReason: "end_turn" } };
	})();
	const response = await collectResponse(model, processConverseStream(events, () => `id_${++nextId}`));
	expect(response.stopReason).toBe("stop");
	expect(response.content).toEqual([
		{ type: "thinking", thinking: "first" },
		{ type: "thinking", thinking: "second" },
	]);
});

test("Bedrock rejects incomplete reasoning and preserves failed tool status", async () => {
	let nextId = 0;
	const response = await collectResponse(model, processConverseStream(converseEvents(false), () => `id_${++nextId}`));
	expect(response.stopReason).toBe("error");
	const messages = toConverseMessages([{ role: "tool", toolCallId: "call_1", content: "failed", error: "Tool execution failed" }]).messages;
	expect(messages[0]?.content).toEqual([{ toolResult: { toolUseId: "call_1", content: [{ text: "failed" }], status: "error" } }]);
});

for (const failure of [false, true]) for (const reportedTotal of [860, 0]) test(`Bedrock cache accounting retains uncached input and cost on ${failure ? "error" : "success"} with total ${reportedTotal}`, async () => {
	const events = (async function* (): AsyncGenerator<ConverseStreamOutput> {
		yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "answer" } } };
		yield { contentBlockStop: { contentBlockIndex: 0 } };
		yield { messageStop: { stopReason: "end_turn" } };
		yield { metadata: { metrics: { latencyMs: 1 }, usage: { inputTokens: 100, outputTokens: 20, totalTokens: reportedTotal, cacheReadInputTokens: 700, cacheWriteInputTokens: 40 } } };
	})();
	const audit = new RawResponseAudit(model, () => {});
	let id = 0;
	for await (const chunk of processConverseStream(events, () => `cache-${++id}`)) {
		// Error terminals use the same normalized usage contract, preserving partial output.
		await audit.accept(failure && chunk.type === EventType.RUN_FINISHED ? { type: EventType.RUN_ERROR, message: "provider failed", ...(chunk.usage ? { usage: chunk.usage } : {}) } : chunk);
	}
	audit.finish(new AbortController().signal);
	const result = audit.partialMessage();
	expect(result.stopReason).toBe(failure ? "error" : "stop");
	expect(result.usage).toMatchObject({ input: 100, cacheRead: 700, cacheWrite: 40, output: 20, totalTokens: 860 });
	expect(result.usage!.cost!.input).toBeCloseTo(0.0003, 10);
	expect(result.usage!.cost!.total).toBeCloseTo(0.00096, 10);
});
