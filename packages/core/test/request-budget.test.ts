import { expect, test } from "bun:test";
import { effectiveOutputTokens } from "../src/session-configuration.ts";
import type { Model } from "../src/session-port.ts";

const model: Model<string> = { id: "anthropic.claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
for (const [name, expected] of [["Claude Sonnet 4.5", 9216], ["Claude Sonnet 4.6", 1024], ["Claude Opus 5", 1024], ["Claude Fable 5", 1024]] as const) test(`Bedrock inference profile output mapping uses display name: ${name}`, () => {
	expect(effectiveOutputTokens({ ...model, id: "arn:aws:bedrock:application-inference-profile/opaque", name }, 1024, "medium")).toBe(expected);
});
test("output reasoning follows provider semantics without inventing an extra budget", () => {
	expect(effectiveOutputTokens({ ...model, api: "openai-responses" }, 1024, "medium")).toBe(1024);
	expect(effectiveOutputTokens(model, 1024, "off")).toBe(1024);
	expect(effectiveOutputTokens({ ...model, api: "anthropic-messages" }, 1024, "medium")).toBe(9216);
	expect(effectiveOutputTokens({ ...model, api: "anthropic-messages", maxTokens: 4096 }, 1024, "medium")).toBe(4096);
});
