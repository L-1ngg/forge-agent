import { createAssistantMessageEventStream } from "../../packages/core/src/model-stream.ts";
import type { AssistantMessage, Context, Message, Model, StopReason as ModelStopReason } from "../../packages/core/src/model-types.ts";
import type { StreamFn } from "../../packages/core/src/sdk.ts";
import type { StopReason } from "../../packages/protocol/src/index.ts";

interface Response {
	text?: string;
	echoLastUser?: boolean;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	stopReason?: StopReason;
	errorMessage?: string;
}

function lastUserText(messages: Message[]): string {
	const message = [...messages].reverse().find(item => item.role === "user");
	if (!message) return "";
	return typeof message.content === "string" ? message.content : message.content.flatMap(item => item.type === "text" ? [item.text] : []).join("");
}

const model: Model = {
	id: "faux-1", name: "Faux Model", api: "faux", provider: "faux", baseUrl: "http://localhost:0",
	reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 16384,
};

function message(selected: Model, context: Context, reply: Response | undefined): AssistantMessage {
	const text = reply?.echoLastUser ? lastUserText(context.messages) : reply?.text;
	const stopReason: ModelStopReason = reply?.stopReason === "tool_use" ? "toolUse" : reply?.stopReason ?? (reply?.toolCalls?.length ? "toolUse" : reply ? "stop" : "error");
	const input = Math.max(1, Math.ceil(((context.systemPrompt ?? "") + JSON.stringify(context.messages) + JSON.stringify(context.tools ?? [])).length / 4));
	const output = Math.max(1, Math.ceil(((text ?? "") + JSON.stringify(reply?.toolCalls ?? [])).length / 4));
	return {
		role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
		content: [...(text ? [{ type: "text" as const, text }] : []), ...(reply?.toolCalls ?? []).map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.arguments }))],
		stopReason,
		...(reply?.errorMessage || !reply ? { errorMessage: reply?.errorMessage ?? "No more faux responses queued" } : {}),
		...(stopReason === "deferred" ? { deferred: { provider: "faux", modelId: "faux-1", api: "faux", id: "deferred-test" } } : {}),
		usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (!ms) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(finish, ms);
		function finish() { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); }
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/** Scripted model transport for SDK and UI tests. */
export function fauxModel(options: { responses: Response[]; tokensPerSecond?: number }) {
	const responses = options.responses.slice();
	const streamFn: StreamFn = (selected, context, settings) => {
		const stream = createAssistantMessageEventStream();
		const reply = responses.shift();
		void (async () => {
			let result = message(selected, context, reply);
			const partial: AssistantMessage = { ...result, content: [] };
			try {
				settings?.signal?.throwIfAborted();
				if (!reply) throw new Error(result.errorMessage);
				stream.push({ type: "start", partial });
				for (const [index, part] of result.content.entries()) {
					if (part.type === "text") {
						partial.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex: index, partial });
						for (const delta of part.text) {
							await wait(Math.floor(1000 / (options.tokensPerSecond ?? 10_000)), settings?.signal);
							settings?.signal?.throwIfAborted();
							const current = partial.content[index];
							if (current?.type === "text") current.text += delta;
							stream.push({ type: "text_delta", contentIndex: index, delta, partial });
						}
						stream.push({ type: "text_end", contentIndex: index, content: part.text, partial });
					} else if (part.type === "toolCall") {
						partial.content.push({ ...part, arguments: {} });
						stream.push({ type: "toolcall_start", contentIndex: index, partial });
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(part.arguments), partial });
						partial.content[index] = part;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial });
					}
				}
			} catch (error) {
				result = { ...partial, stopReason: settings?.signal?.aborted ? "aborted" : "error", errorMessage: String(error) };
			}
			if (result.stopReason === "error" || result.stopReason === "aborted") stream.push({ type: "error", reason: result.stopReason, error: result });
			else if (result.stopReason !== "pending") stream.push({ type: "done", reason: result.stopReason, message: result });
		})();
		return stream;
	};
	return { model: structuredClone(model), streamFn };
}
