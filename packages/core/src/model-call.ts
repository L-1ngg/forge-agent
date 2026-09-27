import { EventType } from "@ag-ui/core";
import { chat, type AdapterYieldChunk, type TextOptions } from "@tanstack/ai";
import type { SessionMessage, SessionEvent } from "@forge-agent/protocol";
import type { SessionConfiguration } from "./configuration.ts";
import { resolveProviderAdapter, providerModelOptions, type ModelAdapter, type ModelRequestSettings } from "./model-adapter.ts";
import { ResponseCollector, toModelMessages } from "./model-response.ts";

/** Validate raw provider completion before any tool phase or durable response commit. */
export async function* observeModelResponse(
	adapter: ModelAdapter, request: TextOptions, configuration: SessionConfiguration,
	emit: (event: SessionEvent) => void | Promise<void>, complete: (message: SessionMessage) => Promise<void>,
): AsyncGenerator<AdapterYieldChunk> {
	const collector = new ResponseCollector(configuration.model, emit, { calculateCost: !configuration.adapter });
	await collector.start();
	let failure: unknown;
	let terminal = false;
	let response: SessionMessage;
	try {
		for await (const chunk of adapter.chatStream(request)) {
			await collector.accept(chunk);
			terminal ||= chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR";
			// Native chat executes a tool phase even after length. Keep that incomplete
			// response in history but stop its native cycle before any tool can run.
			if (chunk.type === "RUN_FINISHED" && (collector.message.stopReason === "length" || collector.message.stopReason === "deferred")) {
				yield { type: EventType.RUN_ERROR, timestamp: Date.now(), message: collector.message.stopReason === "length" ? "max_output_tokens" : "Response deferred", code: collector.message.stopReason === "length" ? "max_tokens" : "deferred" };
			} else if (chunk.type === "RUN_FINISHED" && collector.message.stopReason === "stop" && collector.message.content.some(part => part.type === "tool_call")) {
				// Some compatible providers finish a complete tool response with stop.
				// Preserve the original history terminal but let chat schedule its tools.
				yield { ...chunk, finishReason: "tool_calls" };
			} else yield chunk;
		}
	} catch (error) { failure = error; }
	finally {
		// chat() closes its provider iterator early on RUN_ERROR and cancellation.
		// The response and durable barrier must also settle on that return path.
		response = collector.finish(request.request?.signal ?? undefined, failure);
		await complete(response);
	}
	if (failure !== undefined || !terminal) yield { type: EventType.RUN_ERROR, timestamp: Date.now(), message: response.errorMessage ?? "Model stream ended without a terminal event", code: response.stopReason === "aborted" ? "aborted" : "incomplete-stream" };
}

/** One native chat request, used for summaries; task runs use the same observer. */
export async function callModel(configuration: SessionConfiguration, messages: SessionMessage[], systemPrompt: string, settings: ModelRequestSettings): Promise<SessionMessage> {
	const adapter = configuration.adapter ?? await resolveProviderAdapter(configuration.model, settings);
	let result: SessionMessage | undefined;
	let failure: unknown;
	const observed: ModelAdapter = {
		kind: "text", name: adapter.name, model: adapter.model, "~types": adapter["~types"],
		chatStream: request => observeModelResponse(adapter, request, configuration, () => { }, async message => { result = message; }),
		structuredOutput: request => adapter.structuredOutput(request),
	};
	const linked = linkedController(settings.signal);
	try {
		for await (const _ of chat({ adapter: observed, messages: toModelMessages(messages), ...(settings.sessionId ? { threadId: settings.sessionId } : {}), systemPrompts: [systemPrompt], modelOptions: providerModelOptions(configuration.model, settings), abortController: linked.controller, debug: false, middleware: [{ onError: (_ctx, info) => { failure = info.error; } }] })) { }
	} finally { linked.dispose(); }
	if (result) return result;
	throw failure ?? new Error("Model did not return a response");
}

export function linkedController(signal: AbortSignal): { controller: AbortController; dispose(): void; } {
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	return { controller, dispose: () => signal.removeEventListener("abort", abort) };
}
