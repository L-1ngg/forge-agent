import { expect, test } from "bun:test";
import { UsageTracker, calculateContextUsage, createPiTestPort, estimateContextTokens } from "../src/index.ts";
import type { SessionMessage, TokenUsage } from "@forge-agent/protocol";

const usage: TokenUsage = {
	input: 80,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 90,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

const message = (text: string, messageUsage?: TokenUsage): SessionMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: 1,
	...(messageUsage ? { usage: messageUsage } : {}),
});

test("context usage prefers the current assembly over the last call usage", () => {
	const current = [message("current context")];
	const snapshot = calculateContextUsage({ messages: current, contextTokens: 12, contextWindow: 100, usage });
	expect(snapshot.contextTokens).toBe(12);
	expect(snapshot.contextWindow).toBe(100);
	expect(snapshot.inputTokens).toBe(80);
	expect(snapshot.costUsd).toBe(0.03);

	const estimated = calculateContextUsage({ messages: [message("a much longer current context")], contextWindow: 100, usage });
	expect(estimated.contextTokens).not.toBe(80);
	expect(estimated.contextEstimated).toBe(true);
});

test("usage tracker updates its truth point when the assembled context changes", () => {
	const tracker = new UsageTracker({ contextWindow: 200 });
	tracker.setContext({ messages: [message("old")], contextTokens: 80 });
	tracker.recordUsage(usage);
	tracker.setContext({ messages: [message("new context")], contextTokens: 16 });
	tracker.beginTurn();
	expect(tracker.snapshot()).toMatchObject({ contextTokens: 16, contextWindow: 200, costUsd: 0.03, running: 1 });
	tracker.endTurn();
	expect(tracker.snapshot().running).toBeUndefined();
});

test("fallback context estimation is deterministic", () => {
	const messages = [message("hello")];
	expect(estimateContextTokens(messages)).toBe(3);
	expect(estimateContextTokens(messages)).toBe(estimateContextTokens(messages));
});

test("fallback counts Chinese, JSON arguments and images without counting base64 as text", () => {
	const image: SessionMessage = { role: "user", timestamp: 1, content: [{ type: "image", data: "A".repeat(100000), mimeType: "image/png" }] };
	expect(estimateContextTokens([image])).toBe(1025);
	expect(estimateContextTokens([message("中文测试")])).toBe(2);
	expect(estimateContextTokens([{ role: "assistant", timestamp: 1, content: [{ type: "tool_call", id: "id", name: "read", arguments: { path: "你好.txt" } }] }])).toBe(1 + Math.ceil('read {"path":"你好.txt"}'.length / 4));
});

test.each(["model", "system", "tools", "branch", "projection"])("usage anchor invalidates %s changes", (kind) => {
	const tracker = new UsageTracker();
	const measured: SessionMessage[] = [message("old"), { ...message("answer", usage), role: "assistant", stopReason: "stop" }];
	tracker.setContext({ identity: "original", messages: measured }); tracker.recordUsage(usage);
	tracker.setContext({ identity: ["model", "system", "tools"].includes(kind) ? kind : "original", messages: ["branch", "projection"].includes(kind) ? [message(kind), measured[1]!] : measured });
	expect(tracker.snapshot().contextEstimated).toBe(true);
	expect(tracker.snapshot().contextTokens).not.toBe(90);
});

test("valid task usage includes trailing estimates and invalidates changed request material", () => {
	const tracker = new UsageTracker({ contextWindow: 1000 });
	const assistant: SessionMessage = { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2, stopReason: "stop", usage };
	const measured = [message("task"), assistant];
	tracker.setContext({ messages: measured, identity: "model-a/system-a/tools-a", fixedText: "system-a" });
	tracker.recordUsage(usage);
	expect(tracker.snapshot()).toMatchObject({ contextTokens: 90, contextEstimated: false });
	tracker.setContext({ messages: [...measured, message("12345678")], identity: "model-a/system-a/tools-a", fixedText: "system-a" });
	expect(tracker.snapshot()).toMatchObject({ contextTokens: 93, contextEstimated: true });
	tracker.setContext({ messages: measured, identity: "model-b/system-a/tools-a", fixedText: "system-a" });
	expect(tracker.snapshot().contextTokens).not.toBe(90);
	expect(tracker.snapshot().contextEstimated).toBe(true);
});

test("pi port refreshes context usage after the assembled transcript changes", async () => {
	const port = createPiTestPort({ responses: [{ text: "first" }, { text: "second" }] });
	for await (const _event of port.runTurn("short")) {}
	const first = port.getUsage?.();
	for await (const _event of port.runTurn("a substantially longer second prompt")) {}
	const second = port.getUsage?.();

	expect(first?.contextTokens).toBeDefined();
	expect(second?.contextTokens).toBeDefined();
	expect(second?.contextTokens).toBeGreaterThan(first?.contextTokens ?? -1);
	expect(second?.contextEstimated).toBe(false);
});
