import { expect, test } from "bun:test";
import { getCatalogModel } from "../src/model-catalog.ts";
import { adjustMaxTokensForThinking, calculateCost, getSupportedThinkingLevels, isContextOverflow, isRetryableAssistantError } from "../src/model-policy.ts";
import type { Usage } from "../src/model-types.ts";
import type { SessionMessage } from "@forge-agent/protocol";

const model = getCatalogModel("openai", "gpt-5.4")!;
const usage = (): Usage => ({ input: 300000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const answer = (stopReason: NonNullable<SessionMessage["stopReason"]>, errorMessage?: string): SessionMessage => ({ role: "assistant", content: [], provider: model.provider, model: model.id, usage: usage(), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: 0 });

test("catalog pricing chooses the highest request tier and accounts for cache writes", () => {
	const current = usage();
	calculateCost(model, current);
	expect(current.cost.input).toBe(1.5);
	expect(current.cost.output).toBe(0.00225);
	const anthropic = getCatalogModel("anthropic", "claude-sonnet-4-5")!;
	const cached = { ...usage(), input: 10, output: 0, cacheWrite: 10, cacheWrite1h: 4 };
	calculateCost(anthropic, cached);
	expect(cached.cost.cacheWrite).toBeCloseTo((3.75 * 6 + 3 * 2 * 4) / 1_000_000);
});

test("thinking budget leaves answer room and unavailable levels are excluded", () => {
	expect(adjustMaxTokensForThinking(1024, 4096, "medium")).toEqual({ maxTokens: 4096, thinkingBudget: 3072 });
	expect(getSupportedThinkingLevels({ ...model, thinkingLevelMap: { off: null, max: "max" } })).not.toContain("off");
});

test("overflow and retry classification separates quota from transient errors", () => {
	expect(isContextOverflow(answer("error", "prompt is too long: 300000 tokens > 200000 maximum"), 200000)).toBe(true);
	expect(isContextOverflow(answer("error", "429 rate limit: too many tokens"), 200000)).toBe(false);
	expect(isRetryableAssistantError(answer("error", "503 service unavailable"))).toBe(true);
	expect(isRetryableAssistantError(answer("error", "429 insufficient_quota"))).toBe(false);
	const result: SessionMessage = { role: "toolResult", content: [], toolCallId: "call", toolName: "work", isError: false, timestamp: 0 };
	expect(isContextOverflow(result, 200000)).toBe(false);
});
