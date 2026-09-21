import { McpServer, ResourceTemplate, inputRequired, inputResponse, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
export const calls: Array<{ name: string; args: unknown }> = [];
export function mcpFixture() {
	const server = new McpServer({ name: "forge-mcp-fixture", version: "1" });
	server.registerTool("complex", { inputSchema: fromJsonSchema<Record<string, unknown>>({ type: "object", $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { positive: { type: "integer", minimum: 1 } }, properties: { value: { $ref: "#/$defs/positive" }, alternative: { type: "boolean" } }, oneOf: [{ required: ["value"] }, { required: ["alternative"] }], additionalProperties: true }) }, args => { calls.push({ name: "complex", args }); return { content: [{ type: "text", text: JSON.stringify(args) }] }; });
    server.registerTool("url", { inputSchema: z.object({}) }, async (_, ctx) => { const result = inputResponse(ctx.mcpReq.inputResponses, "url"); if (result.kind === "missing") return inputRequired({ inputRequests: { url: inputRequired.elicitUrl({ message: "Open fixture authorization", url: "https://example.test/fixture" }) } }); return { content: [{ type: "text", text: JSON.stringify(result) }] }; });
    server.registerTool("echo", { inputSchema: z.object({ value: z.string() }), outputSchema: z.object({ value: z.string() }) }, args => { calls.push({ name: "echo", args }); return { content: [{ type: "text", text: args.value }], structuredContent: args }; });
	server.registerTool("bad_output", { outputSchema: z.object({ ok: z.boolean() }) }, () => ({ content: [{ type: "text", text: "invalid" }], structuredContent: { wrong: true } }));
	server.registerTool("slow", { inputSchema: z.object({}) }, async () => { calls.push({ name: "slow", args: {} }); await new Promise(resolve => setTimeout(resolve, 1000)); return { content: [{ type: "text", text: "late" }] }; });
	server.registerTool("form", { inputSchema: z.object({}) }, async (_, ctx) => {
        const result = inputResponse(ctx.mcpReq.inputResponses, "form");
        if (result.kind === "missing") return inputRequired({ inputRequests: { form: inputRequired.elicit({ message: "Choose count", requestedSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } }) } });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
	server.registerTool("media", {}, () => ({ content: [{ type: "audio", mimeType: "audio/wav", data: Buffer.from("original audio").toString("base64") }, { type: "resource_link", name: "linked", uri: "fixture://data" }], structuredContent: { ok: true } }));
	server.registerResource("data", "fixture://data", { mimeType: "text/plain" }, uri => { calls.push({ name: "read", args: uri.href }); return { contents: [{ uri: uri.href, text: "RESOURCE EVIDENCE" }] }; });
	server.registerResource("item", new ResourceTemplate("fixture://item/{id}", { list: undefined, complete: { id: () => ["one", "two"] } }), {}, (uri, vars) => ({ contents: [{ uri: uri.href, text: String(vars.id) }] }));
	server.registerPrompt("template", { argsSchema: z.object({ subject: z.string() }) }, ({ subject }) => { calls.push({ name: "prompt", args: subject }); return { messages: [{ role: "user", content: { type: "text", text: `TEMPLATE ${subject}` } }, { role: "assistant", content: { type: "text", text: "EXTERNAL ASSISTANT CONTEXT" } }] }; });
	return server;
}
if (import.meta.main) serveStdio(mcpFixture);
