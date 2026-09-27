import type { SessionMessage } from "@forge-agent/protocol";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { providerModelOptions, resolveProviderAdapter, type ModelRequestSettings } from "../../src/model-adapter.ts";
import { ResponseCollector, toModelMessages } from "../../src/model-response.ts";
import type { Model } from "../../src/model-types.ts";

/** Exercises the raw native-adapter seam without starting a session/tool loop. */
export async function collectResponse(model: Model, chunks: AsyncIterable<AdapterYieldChunk>, signal?: AbortSignal): Promise<SessionMessage> {
	const collector = new ResponseCollector(model, () => {});
	let error: unknown;
	try { for await (const chunk of chunks) await collector.accept(chunk); }
	catch (caught) { error = caught; }
	return collector.finish(signal, error);
}

export async function nativeRequest(model: Model, messages: SessionMessage[], settings: Partial<ModelRequestSettings> = {}): Promise<SessionMessage> {
	const request = { signal: new AbortController().signal, maxTokens: model.maxTokens, ...settings };
	const adapter = await resolveProviderAdapter(model, request);
	return collectResponse(model, adapter.chatStream({ model: adapter.model, messages: toModelMessages(messages), modelOptions: providerModelOptions(model, request), request: { signal: request.signal }, logger: resolveDebugOption(false) }), request.signal);
}
