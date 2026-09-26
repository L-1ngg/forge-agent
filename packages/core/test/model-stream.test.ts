import { expect, test } from "bun:test";
import { EventStream, createAssistantMessageEventStream, type AssistantMessage } from "../src/model-stream.ts";

const answer: AssistantMessage = {
	role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-responses", provider: "openai", model: "fixture",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: 1,
};

test("assistant stream publishes the terminal event and settles its result once", async () => {
	const stream = createAssistantMessageEventStream();
	const events = (async () => { const seen = []; for await (const event of stream) seen.push(event.type); return seen; })();
	stream.push({ type: "start", partial: answer });
	stream.push({ type: "done", reason: "stop", message: answer });
	stream.push({ type: "start", partial: answer });
	expect(await events).toEqual(["start", "done"]);
	expect(await stream.result()).toBe(answer);
});

test("generic stream end wakes a waiting iterator and returns its final result", async () => {
	const stream = new EventStream<number, string>(() => false, () => "unexpected");
	const events = (async () => { const seen = []; for await (const event of stream) seen.push(event); return seen; })();
	stream.push(1);
	stream.end("finished");
	expect(await events).toEqual([1]);
	expect(await stream.result()).toBe("finished");
});
