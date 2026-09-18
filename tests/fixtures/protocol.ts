/** Hand-authored protocol fixtures, not recordings. Changes require the review
 * procedure in README.md. No credentials or real conversation data. */
export const fixtureProvenance = {
	version: 1, source: "handwritten", adapter: "@earendil-works/pi-ai@0.85.1",
	protocols: ["anthropic-messages", "openai-responses"],
	ignoredRequestFields: ["metadata.user_id", "prompt_cache_key", "cache_control"],
	// Tests project relevant messages/tools explicitly; IDs, arguments and order are never normalized.
} as const;
export type Protocol = "anthropic" | "responses";
export const protocols: Protocol[] = ["anthropic", "responses"];
export function settings(protocol: Protocol) {
	return protocol === "anthropic"
		? { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture-only" }
		: { provider: "xai", model: "grok-4.6", apiKey: "fixture-only" };
}
export function path(protocol: Protocol): string { return protocol === "anthropic" ? "/v1/messages" : "/responses"; }
const frame = (event: { type: string; [key: string]: unknown }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export function frames(protocol: Protocol, tool = false): string[] {
	if (protocol === "anthropic") return [
		frame({ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		frame({ type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "call_1", name: "capture", input: {} } : { type: "text", text: "" } }),
		...(tool ? [
			frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value":' } }),
			frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"你好"}' } }),
		] : [frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好🌍" } })]),
		frame({ type: "content_block_stop", index: 0 }),
		frame({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
		frame({ type: "message_stop" }),
	];
	const item = tool ? { type: "function_call", id: "fc_fixture", call_id: "call_1", name: "capture", arguments: '{"value":"你好"}', status: "completed" }
		: { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "你好🌍", annotations: [] }] };
	return [
		frame({ type: "response.created", response: { id: "resp_fixture" } }),
		frame({ type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "" } : { ...item, content: [] } }),
		...(tool ? [
			frame({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"value":' }),
			frame({ type: "response.function_call_arguments.delta", output_index: 0, delta: '"你好"}' }),
		] : [frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你好🌍" })]),
		frame({ type: "response.output_item.done", output_index: 0, item }),
		frame({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }),
	];
}

export function bytes(value: string): Uint8Array[] {
	return [...new TextEncoder().encode(value)].map(byte => new Uint8Array([byte]));
}

export function failedFrames(protocol: Protocol): string[] {
	return protocol === "anthropic"
		? [...frames(protocol, true).slice(0, 4), frame({ type: "error", error: { type: "invalid_request_error", message: "fixture terminal failure" } })]
		: [...frames(protocol, true).slice(0, 4), frame({ type: "response.failed", response: { id: "resp_fixture", status: "failed", error: { code: "invalid_request_error", message: "fixture terminal failure" } } })];
}
