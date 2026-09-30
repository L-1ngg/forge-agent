import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mcpToolName } from "../../packages/core/src/mcp/config.ts";
import { modelResponse } from "../fixtures/model-response.ts";
import { bounded } from "../support/control.ts";
import { PtyDriver } from "../support/pty.ts";
import { withScenario } from "../support/scenario.ts";

test("formal CLI PTY: MCP catalogs, prompt input ownership, typed elicitation, and clean exit", async () => withScenario("formal CLI PTY: MCP catalogs, prompt input ownership, typed elicitation, and clean exit", async scenario => {
	const cwd = scenario.cwd;
	const fixture = scenario.httpFixture("mcp-pty", [
		{ id: "prompt", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("TEMPLATE PTY"); expect(JSON.stringify(body)).toContain("MCP_TASK"); }, response: { chunks: [await modelResponse([], "end_turn", "MCP_PROMPT_COMPLETE").text()] } },
		{ id: "form-call", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("Run form"); }, response: { chunks: [await modelResponse([{ id: "form", name: mcpToolName("fixture", "form"), arguments: {} }]).text()] } },
		{ id: "form-result", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain('\\"count\\":7'); }, response: { chunks: [await modelResponse([], "end_turn", "MCP_FORM_COMPLETE").text()] } },
		{ id: "cancel-call", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("Run cancel"); }, response: { chunks: [await modelResponse([{ id: "cancel", name: mcpToolName("fixture", "form"), arguments: {} }]).text()] } },
        { id: "cancel-result", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("cancel"); }, response: { chunks: [await modelResponse([], "end_turn", "MCP_CANCEL_COMPLETE").text()] } },
	]);
	await mkdir(join(cwd, ".forge-agent"));
	await writeFile(join(cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: fixture.url, memory: { autoUpdate: false, injection: false }, mcp: { servers: { fixture: { transport: "stdio", protocol: "2026-07-28", command: process.execPath, args: [resolve(import.meta.dir, "../../packages/core/test/helpers/mcp-server.ts")] } } } }));

	const pty = new PtyDriver([resolve(import.meta.dir, "../../packages/cli/src/main.ts"), "--no-skills"], { columns: 180, rows: 48, cwd, env: { PATH: process.env.PATH, HOME: cwd, TERM: "xterm-256color", XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data") } });
	scenario.defer(() => pty.close());
	const terminal = pty, child = pty.child;
	const wait = (text: string) => pty.waitFor(() => pty.screenText.includes(text), text);
	const permission = (name: string) => pty.waitFor(() => pty.screenText.includes(`Permission: ${name}`) && pty.screenText.includes("Yes, allow once"), `active permission ${name}`);
	await wait("ctrl+c"); terminal.write("/mcp tools fixture\r"); await wait("remoteName"); expect(fixture.count).toBe(0);
	terminal.write('/mcp use-prompt fixture template --args \'{"subject":"PTY"}\' -- MCP_TASK\r'); await permission("mcp_get_prompt"); terminal.write("\r"); await wait("MCP_PROMPT_COMPLETE");
	pty.clear(); terminal.write("Run form\r"); await permission(mcpToolName("fixture", "form")); terminal.write("\r"); await wait("Choose count");
	terminal.write("7\x10"); await wait("parked"); terminal.write("\t\t\r"); await wait("MCP_FORM_COMPLETE");
	await pty.waitFor(() => !pty.screenText.includes("working"), "form turn settled");
	if (pty.screenText.includes("tab:input")) { terminal.write("\t"); await wait("enter:send"); }
	pty.clear(); terminal.write("Run cancel\r"); await permission(mcpToolName("fixture", "form")); terminal.write("\r"); await wait("Choose count"); terminal.write("\x1b"); await wait("MCP_CANCEL_COMPLETE");
        terminal.write("/new "); await wait("❯ /new");
        pty.clear(); terminal.write("\r"); await pty.waitFor(() => pty.text.length > 0 && pty.screenText.includes("Type a message"), "new session painted"); terminal.write("/mcp status\r"); await wait('"ready"');
        terminal.write("/quit\r"); expect(await bounded(child.exited, "MCP PTY exit")).toBe(0); expect(pty.text).toContain("\x1b[?1049l");
}, { timeoutMs: 26000 }), 35_000);
