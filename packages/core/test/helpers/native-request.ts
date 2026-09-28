import type { SessionMessage } from "@forge-agent/protocol";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { callModel } from "../../src/model-call.ts";
import type { ModelRequestSettings } from "../../src/model-adapter.ts";
import type { SessionConfiguration } from "../../src/configuration.ts";
import type { Model } from "../../src/model-types.ts";
import { nativeAdapter } from "./native-adapter.ts";

const user: SessionMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 };
const configuration = (model: Model, adapter?: SessionConfiguration["adapter"]): SessionConfiguration => ({ model, thinkingLevel: "off", systemPrompt: "test", cwd: process.cwd(), ...(adapter ? { adapter } : {}) });

/** Exercises the same chat() response boundary used by summaries. */
export async function collectResponse(model: Model, chunks: AsyncIterable<AdapterYieldChunk>, signal?: AbortSignal): Promise<SessionMessage> {
	return callModel(configuration(model, nativeAdapter(model, () => chunks)), [user], "test", { signal: signal ?? new AbortController().signal, maxTokens: model.maxTokens });
}

export async function nativeRequest(model: Model, messages: SessionMessage[], settings: Partial<ModelRequestSettings> = {}): Promise<SessionMessage> {
	const request = { signal: new AbortController().signal, maxTokens: model.maxTokens, ...settings };
	return callModel(configuration(model), messages, "test", request);
}
