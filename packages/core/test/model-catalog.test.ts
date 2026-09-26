import { expect, test } from "bun:test";
import { getCatalogModel, listCatalogModels, listCatalogProviders } from "../src/model-catalog.ts";
import { createAgent } from "../src/sdk.ts";

test("Forge catalog contains only supported built-in transport models", async () => {
	const providers = listCatalogProviders();
	const models = listCatalogModels();
	expect(providers).toHaveLength(37);
	expect(models).toHaveLength(1314);
	expect(providers).not.toContain("mistral");
	expect(providers).not.toContain("openai-codex");
	expect(models.some(model => model.api === "mistral-conversations" || model.api === "openai-codex-responses")).toBe(false);
	expect(getCatalogModel("openai", "gpt-4.1-mini")).toMatchObject({ api: "openai-responses", contextWindow: 1047576, cost: { input: 0.4, output: 1.6 } });
	expect(getCatalogModel("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0")?.api).toBe("bedrock-converse-stream");
	expect(getCatalogModel("openai", "missing-model")).toBeUndefined();
	await expect(createAgent({ provider: "mistral", model: "mistral-large-latest", cwd: process.cwd(), systemPrompt: "test", thinkingLevel: "off" })).rejects.toThrow("Unknown model");
});
