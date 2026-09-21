import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
export function factory() {
  const server = new McpServer({ name: "forge-probe", version: "1" });
  server.registerTool(
    "echo",
    {
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
    },
    ({ value }) => ({
      content: [{ type: "text", text: value }],
      structuredContent: { value },
    }),
  );
  server.registerTool("slow", { inputSchema: z.object({}) }, async (_, ctx) => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      ctx.mcpReq.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
    return { content: [{ type: "text", text: "done" }] };
  });
  server.registerResource(
    "readme",
    "probe://readme",
    { mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "resource text" }] }),
  );
  server.registerResource(
    "item",
    new ResourceTemplate("probe://items/{id}", {
      list: undefined,
      complete: { id: () => ["one", "two"] },
    }),
    { mimeType: "text/plain" },
    async (uri, vars) => ({
      contents: [{ uri: uri.href, text: String(vars.id) }],
    }),
  );
  server.registerPrompt(
    "greet",
    { argsSchema: z.object({ name: z.string() }) },
    ({ name }) => ({
      messages: [
        { role: "user", content: { type: "text", text: `Hello ${name}` } },
      ],
    }),
  );
  return server;
}
if (import.meta.main) serveStdio(factory);
