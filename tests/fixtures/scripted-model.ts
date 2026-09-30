import type { SessionMessage } from "../../packages/protocol/src/index.ts";
import { SUMMARY_SYSTEM, type SummaryDriver } from "../../packages/core/src/context/compaction.ts";
import { nativeAdapter, requestMessages, responseChunks } from "./native-adapter.ts";

export interface ScriptedModel extends Pick<SummaryDriver, "maxTokens" | "summarize"> {
	contextWindow: number;
	stream(messages: readonly SessionMessage[], signal: AbortSignal): Promise<SessionMessage>;
}

/** Controlled model responses use native adapter chunks; no session or tool state. */
export function scriptedModel(driver: ScriptedModel) {
	const model = { id: "script", name: "script", api: "faux", provider: "faux", baseUrl: "", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: driver.contextWindow, maxTokens: driver.maxTokens ?? 1000 };
	const adapter = nativeAdapter(model, async function* (request) {
		const signal = request.request?.signal ?? request.abortController?.signal ?? new AbortController().signal;
		try {
			signal.throwIfAborted();
			const messages = requestMessages(request.messages);
			const system = request.systemPrompts?.map(prompt => typeof prompt === "string" ? prompt : prompt.content).join("\n");
			const modelOptions = request.modelOptions;
			const reasoning = modelOptions?.reasoning;
			const result = system === SUMMARY_SYSTEM && driver.summarize
				? await driver.summarize({
					prompt: messages.flatMap(message => message.content.flatMap(block => block.type === "text" ? [block.text] : [])).join("\n"),
					maxTokens: typeof modelOptions?.max_output_tokens === "number" ? modelOptions.max_output_tokens : model.maxTokens,
					reasoning: reasoning && typeof reasoning === "object" && "effort" in reasoning ? "inherit" : "off",
				}, signal)
				: await driver.stream(messages, signal);
			yield* responseChunks({ ...result, ...(signal.aborted ? { stopReason: "aborted" as const } : {}) });
		} catch (error) {
			yield* responseChunks({ role: "assistant", content: [], timestamp: Date.now(), stopReason: signal.aborted ? "aborted" : "error", errorMessage: String(error) });
		}
	});
	return { model, adapter };
}
