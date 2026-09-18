import { deepStrictEqual } from "node:assert";
import { settings, type Protocol } from "./protocol.ts";

/** Only cache_control is removed from message bodies. Role/order/call identity,
 * parameters and terminal tool-result meaning remain exact protocol assertions. */
export function expectedMessages(protocol: Protocol, continuation: boolean): unknown[] {
	if (protocol === "anthropic") return [
		{ role: "user", content: [{ type: "text", text: "protocol prompt" }] },
		...(continuation ? [
			{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "capture", input: { value: "你好" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "captured:你好", is_error: false }] },
		] : []),
	];
	return [
		{ role: "developer", content: "Deterministic test" },
		{ role: "user", content: [{ type: "input_text", text: "protocol prompt" }] },
		...(continuation ? [
			{ type: "function_call", id: "fc_fixture", call_id: "call_1", name: "capture", arguments: '{"value":"你好"}' },
			{ type: "function_call_output", call_id: "call_1", output: "captured:你好" },
		] : []),
	];
}

export function matchProtocolRequest(protocol: Protocol, continuation = false): (body: unknown) => void {
	return body => {
		const request = body as { model: string; stream: boolean; messages?: unknown[]; input?: unknown[]; tools: Array<{ name: string; input_schema?: unknown; parameters?: unknown }> };
		deepStrictEqual(request.model, settings(protocol).model);
		deepStrictEqual(request.stream, true);
		deepStrictEqual(request.tools.map(tool => tool.name), ["capture", "read_context", "search_context"]);
		const tool = request.tools[0]!;
		deepStrictEqual(tool.input_schema ?? tool.parameters, { type: "object", properties: { value: { type: "string" } }, required: ["value"], ...(protocol === "responses" ? { additionalProperties: false } : {}) });
		const messages = protocol === "anthropic" ? request.messages : request.input;
		const normalized = structuredClone(messages);
		if (protocol === "anthropic" && Array.isArray(normalized)) for (const message of normalized) {
			if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) continue;
			for (const block of message.content) if (block && typeof block === "object") delete block.cache_control;
		}
		deepStrictEqual(normalized, expectedMessages(protocol, continuation));
	};
}
