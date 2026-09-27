import { nativeAdapter, responseChunks } from "../../packages/core/test/helpers/native-adapter.ts";
import type { Model } from "../../packages/core/src/model-types.ts";
import type { SessionMessage, StopReason } from "../../packages/protocol/src/index.ts";

interface Response {
	text?: string;
	echoLastUser?: boolean;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	stopReason?: StopReason;
	errorMessage?: string;
}

const model: Model = {
	id: "faux-1", name: "Faux Model", api: "faux", provider: "faux", baseUrl: "http://localhost:0",
	reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 16384,
};

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (!ms || signal?.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(finish, ms);
		function finish() { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); }
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/** Controlled native adapter shared by SDK and UI tests. */
export function fauxModel(options: { responses: Response[]; tokensPerSecond?: number }) {
	const responses = options.responses.slice();
	const adapter = nativeAdapter(model, async function* (request) {
		const reply = responses.shift();
		const signal = request.request?.signal ?? request.abortController?.signal;
		const lastUser = [...request.messages].reverse().find(message => message.role === "user");
		const lastText = typeof lastUser?.content === "string" ? lastUser.content : lastUser?.content?.flatMap(part => part.type === "text" ? [part.content] : []).join("") ?? "";
		const text = reply?.echoLastUser ? lastText : reply?.text;
		const input = Math.max(1, Math.ceil((JSON.stringify(request.systemPrompts ?? []) + JSON.stringify(request.messages) + JSON.stringify(request.tools ?? [])).length / 4));
		const output = Math.max(1, Math.ceil(((text ?? "") + JSON.stringify(reply?.toolCalls ?? [])).length / 4));
		const result: SessionMessage = {
			role: "assistant", timestamp: Date.now(),
			content: [...(text ? [{ type: "text" as const, text }] : []), ...(reply?.toolCalls ?? []).map(call => ({ type: "tool_call" as const, ...call }))],
			stopReason: reply?.stopReason ?? (reply?.toolCalls?.length ? "tool_use" : reply ? "stop" : "error"),
			...(reply?.errorMessage || !reply ? { errorMessage: reply?.errorMessage ?? "No more faux responses queued" } : {}),
			usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
		};
		try {
			signal?.throwIfAborted();
			for (const chunk of responseChunks(result)) {
				if (chunk.type === "TEXT_MESSAGE_CONTENT") {
					for (const delta of chunk.delta) {
						await wait(Math.floor(1000 / (options.tokensPerSecond ?? 10_000)), signal);
						signal?.throwIfAborted();
						yield { ...chunk, delta };
					}
				} else yield chunk;
			}
		} catch (error) {
			yield* responseChunks({ role: "assistant", content: [], timestamp: Date.now(), stopReason: signal?.aborted ? "aborted" : "error", errorMessage: String(error) });
		}
	});
	return { model: structuredClone(model), adapter };
}
