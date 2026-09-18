import { expect, test } from "bun:test";
import { matchProtocolRequest, expectedMessages } from "./protocol-request.ts";
import { protocols, settings } from "./protocol.ts";

for (const protocol of protocols) test(`${protocol}: replay refuses corrupted tool identity, arguments, order and schema`, () => {
	const messages = expectedMessages(protocol, true);
	const parameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"], ...(protocol === "responses" ? { additionalProperties: false } : {}) };
	const request = { model: settings(protocol).model, stream: true, [protocol === "anthropic" ? "messages" : "input"]: messages, tools: [{ name: "capture", [protocol === "anthropic" ? "input_schema" : "parameters"]: parameters }, { name: "read_context" }, { name: "search_context" }] };
	const match = matchProtocolRequest(protocol, true);
	expect(() => match(request)).not.toThrow();
	// Modify only the result identity: the original call ID remains elsewhere.
	const wrongId = JSON.stringify(request).replace(protocol === "anthropic" ? '"tool_use_id":"call_1"' : '"function_call_output","call_id":"call_1"', protocol === "anthropic" ? '"tool_use_id":"wrong"' : '"function_call_output","call_id":"wrong"');
	expect(() => match(JSON.parse(wrongId))).toThrow();
	expect(() => match(JSON.parse(JSON.stringify(request).replace("你好", "wrong")))).toThrow();
	expect(() => match({ ...request, [protocol === "anthropic" ? "messages" : "input"]: [...messages].reverse() })).toThrow();
	expect(() => match(JSON.parse(JSON.stringify(request).replace('"required":["value"]', '"required":[]')))).toThrow();
	if (protocol === "anthropic") expect(() => match(JSON.parse(JSON.stringify(request).replace('"input":{"value":"你好"}', '"input":{"value":"你好","cache_control":"unexpected argument"}')))).toThrow();
});
