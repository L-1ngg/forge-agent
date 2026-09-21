/** Catalog/read-only MCP example. No model request is made.
 * bun examples/mcp-client.ts bun packages/core/test/helpers/mcp-server.ts
 * Replace the command/arguments with your own stdio MCP server.
 */
import { createAgent } from "../packages/core/src/sdk.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: bun examples/mcp-client.ts <server-command> [args...]");
const agent = await createAgent({
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	apiKey: "unused-no-model-request",
	systemPrompt: "MCP catalog example",
	cwd: process.cwd(),
	permission: { rules: [{ tool: "mcp_read_resource", argsPattern: "*", effect: "allow" }] },
	mcp: { servers: { example: { transport: "stdio", command, args } } },
});
try {
	console.log(JSON.stringify(agent.mcp.snapshot(), null, 2));
	const resource = (await agent.mcp.listResources("example"))[0];
	if (resource) console.log(JSON.stringify(await agent.mcp.readResource("example", resource.uri), null, 2));
} finally {
	await agent.dispose();
}
