/** Local Anthropic SSE fixture; traverses the real HTTP/provider adapter. */
export function modelResponse(calls: Array<{ id: string; name: string; arguments: object }> = [], stopReason = calls.length ? "tool_use" : "end_turn"): Response {
	const blocks = calls.length ? calls.map(call => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })) : [{ type: "text", text: "saved answer" }];
	const events = [
		{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
		...blocks.flatMap((content_block, index) => [{ type: "content_block_start", index, content_block: calls.length ? { ...content_block, input: {} } : content_block }, ...(calls[index] ? [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(calls[index]!.arguments) } }] : []), { type: "content_block_stop", index }]),
		{ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
export function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
