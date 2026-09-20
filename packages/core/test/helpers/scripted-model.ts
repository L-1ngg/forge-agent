import { EventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import type { StreamFn } from "../../src/sdk.ts";
import { fromSessionMessage, toSessionMessage } from "../../src/event-projection.ts";
import { SUMMARY_SYSTEM, type SummaryDriver } from "../../src/context/compaction.ts";

export interface ScriptedModel extends Pick<SummaryDriver, "maxTokens" | "summarize"> {
	contextWindow: number;
	stream(messages: readonly SessionMessage[], signal: AbortSignal, emit: (event: SessionEvent) => void): Promise<SessionMessage>;
}
/** Converts controlled model responses into Pi events; owns no session, tools or storage. */
export function scriptedModel(driver: ScriptedModel) {
	const model = { id: "script", name: "script", api: "faux", provider: "faux", baseUrl: "", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: driver.contextWindow, maxTokens: driver.maxTokens ?? 1000 };
	const streamFn: StreamFn = (selected, request, options) => {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(event => event.type === "done" || event.type === "error", event => { if (event.type === "done") return event.message; if (event.type === "error") return event.error; throw new Error("Unexpected result"); });
		const signal = options?.signal ?? new AbortController().signal;
		const partial = fromSessionMessage({ role: "assistant", content: [], timestamp: 0, stopReason: "stop" }, selected) as AssistantMessage;
		void (async () => {
			try {
				signal.throwIfAborted(); stream.push({ type: "start", partial });
				const messages = request.messages.map(message => toSessionMessage(message)!);
				const result = request.systemPrompt === SUMMARY_SYSTEM && driver.summarize
					? await driver.summarize({ prompt: messages.flatMap(message => message.content.flatMap(block => block.type === "text" ? [block.text] : [])).join("\n"), maxTokens: options?.maxTokens ?? model.maxTokens, reasoning: options?.reasoning ? "inherit" : "off" }, signal)
					: await driver.stream(messages, signal, event => {
						if (event.type === "message_delta") stream.push({ type: event.contentType === "text" ? "text_delta" : event.contentType === "thinking" ? "thinking_delta" : "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta, partial });
					});
				const message = fromSessionMessage({ ...result, ...(signal.aborted ? { stopReason: "aborted" } : {}) }, selected) as AssistantMessage;
				if (message.stopReason === "pending") throw new Error("Expected a terminal scripted response");
				if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
				else stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
			} catch (error) {
				const message: AssistantMessage = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: String(error) };
				stream.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error: message }); stream.end(message);
			}
		})();
		return stream;
	};
	return { model, streamFn };
}
