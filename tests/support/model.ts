import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
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
	const message = [...messages].reverse().find(message => message.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
}
/** Model transport only. Execution, tools and storage stay on the public SDK path. */
export function fauxModel(options: { responses: Response[]; tokensPerSecond?: number }) {
	const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 10_000, tokenSize: { min: 1, max: 1 } });
	faux.setResponses(options.responses.map(response => context => {
		const text = response.echoLastUser ? lastUserText(context.messages) : response.text;
		const stopReason = response.stopReason === "tool_use" ? "toolUse" : response.stopReason ?? (response.toolCalls?.length ? "toolUse" : "stop");
		return fauxAssistantMessage([
			...(text ? [fauxText(text)] : []),
			...(response.toolCalls ?? []).map(call => fauxToolCall(call.name, call.arguments, { id: call.id })),
		], {
			stopReason,
			...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
			...(stopReason === "deferred" ? { deferred: { provider: "faux", modelId: "faux-1", api: "faux", id: "deferred-test" } } : {}),
		});
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const streamFn: StreamFn = models.streamSimple.bind(models);
	return { model: faux.getModel(), streamFn };
}
