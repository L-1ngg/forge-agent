import { EventType } from "@ag-ui/core";
import { chat, type AdapterYieldChunk, type TextOptions, type TokenUsage } from "@tanstack/ai";
import type { SessionMessage, SessionEvent } from "@forge-agent/protocol";
import type { SessionConfiguration } from "./configuration.ts";
import { resolveProviderAdapter, providerModelOptions, type ModelAdapter, type ModelRequestSettings } from "./model-adapter.ts";
import { RawResponseAudit, toModelMessages } from "./model-response.ts";

/** Validate raw provider completion before any tool phase or durable response commit. */
export async function* observeModelResponse(
	adapter: ModelAdapter, request: TextOptions, configuration: SessionConfiguration,
	emit: (event: SessionEvent) => void | Promise<void>, complete: (audit: RawResponseAudit) => void | Promise<void>,
): AsyncGenerator<AdapterYieldChunk> {
	const audit = new RawResponseAudit(configuration.model, emit, !configuration.adapter);
	let failure: unknown;
	let terminal: AdapterYieldChunk | undefined;
	await audit.start();
	try {
		for await (const chunk of adapter.chatStream(request)) {
			await audit.accept(chunk);
			if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") terminal = chunk;
			else yield chunk;
		}
	} catch (error) { failure = error; }
	finally {
		// The raw iterator and its finally settle before chat() sees a terminal.
		audit.finish(request.request?.signal ?? undefined, failure);
		await complete(audit);
	}
	if (failure !== undefined || !terminal || request.request?.signal?.aborted) {
		yield { type: EventType.RUN_ERROR, timestamp: Date.now(), message: audit.failure ?? "Model stream ended without a terminal event", code: audit.reason === "aborted" ? "aborted" : "incomplete-stream" };
	} else if (terminal.type === "RUN_FINISHED" && (audit.reason === "length" || audit.reason === "deferred")) {
		// chat() would otherwise start a tool phase for a truncated response.
		yield { type: EventType.RUN_ERROR, timestamp: Date.now(), message: audit.reason === "length" ? "max_output_tokens" : "Response deferred", code: audit.reason === "length" ? "max_tokens" : "deferred" };
	} else if (terminal.type === "RUN_FINISHED" && audit.reason === "stop" && audit.hasTools) {
		// A complete tool proposal may be labelled stop by a compatible provider.
		yield { ...terminal, finishReason: "tool_calls" };
	} else yield terminal;
}

/** One native chat request for summaries and memory; task runs use the same observer. */
export async function callModel(configuration: SessionConfiguration, messages: SessionMessage[], systemPrompt: string, settings: ModelRequestSettings, hooks?: { onRequest?: () => void; onUsage?: (usage: TokenUsage) => void }): Promise<SessionMessage> {
	const adapter = configuration.adapter ?? await resolveProviderAdapter(configuration.model, settings);
	let result: SessionMessage | undefined;
	let failure: unknown;
	let audit: RawResponseAudit | undefined;
	let nativeUsage: TokenUsage | undefined;
	const input = toModelMessages(messages);
	const observed: ModelAdapter = {
		kind: "text", name: adapter.name, model: adapter.model, "~types": adapter["~types"],
		chatStream: request => { hooks?.onRequest?.(); return observeModelResponse(adapter, request, configuration, () => { }, settled => { audit = settled; }); },
		structuredOutput: request => adapter.structuredOutput(request),
	};
	const linked = linkedController(settings.signal);
	try {
		for await (const _ of chat({ adapter: observed, messages: input, ...(settings.sessionId ? { threadId: settings.sessionId } : {}), systemPrompts: [systemPrompt], modelOptions: providerModelOptions(configuration.model, settings), abortController: linked.controller, debug: false, middleware: [{
			onFinish: ctx => { if (audit) result = audit.project(ctx.messages.slice(input.length)); },
			onError: (_ctx, info) => { failure = info.error; if (audit) result = audit.partialMessage(); },
			onAbort: () => { if (audit) result = audit.partialMessage("aborted", "Request aborted"); },
			onUsage: (_ctx, usage) => { nativeUsage = usage; },
		}] })) { }
	} catch (error) { failure = error; }
	finally { linked.dispose(); }
	const usage = nativeUsage ?? audit?.reportedUsage;
	if (usage) hooks?.onUsage?.(usage);
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
