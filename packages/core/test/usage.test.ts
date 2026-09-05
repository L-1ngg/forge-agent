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

test("pi port refreshes context usage after the assembled transcript changes", async () => {
	const port = createPiTestPort({ responses: [{ text: "first" }, { text: "second" }] });
	for await (const _event of port.runTurn("short")) {}
	const first = port.getUsage?.();
	for await (const _event of port.runTurn("a substantially longer second prompt")) {}
	const second = port.getUsage?.();

	expect(first?.contextTokens).toBeDefined();
	expect(second?.contextTokens).toBeDefined();
	expect(second?.contextTokens).toBeGreaterThan(first?.contextTokens ?? -1);
	expect(second?.contextEstimated).toBe(true);
});
