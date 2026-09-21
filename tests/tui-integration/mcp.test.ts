import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HttpFixture } from "../support/http-fixture.ts";
import { modelResponse } from "../../packages/core/test/helpers/model-response.ts";
import { mcpToolName } from "../../packages/core/src/mcp/config.ts";
import { bounded } from "../support/control.ts";

test("formal CLI PTY: MCP catalogs, prompt input ownership, typed elicitation, and clean exit", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-pty-")); let output = "";
	const fixture = new HttpFixture("mcp-pty", [
		{ id: "prompt", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("TEMPLATE PTY"); expect(JSON.stringify(body)).toContain("MCP_TASK"); }, response: { chunks: [await modelResponse([], "end_turn", "MCP_PROMPT_COMPLETE").text()] } },
		{ id: "form-call", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("Run form"); }, response: { chunks: [await modelResponse([{ id: "form", name: mcpToolName("fixture", "form"), arguments: {} }]).text()] } },
		{ id: "form-result", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain('\\"count\\":7'); }, response: { chunks: [await modelResponse([], "end_turn", "MCP_FORM_COMPLETE").text()] } },
		{ id: "cancel-call", method: "POST", path: "/v1/messages", match() {}, response: { chunks: [await modelResponse([{ id: "cancel", name: mcpToolName("fixture", "form"), arguments: {} }]).text()] } },
        { id: "cancel-result", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("cancel"); }, response: { chunks: [await modelResponse([], "end_turn", "MCP_CANCEL_COMPLETE").text()] } },
	]);
	await mkdir(join(cwd, ".forge-agent"));
	await writeFile(join(cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: fixture.url, mcp: { servers: { fixture: { transport: "stdio", protocol: "2026-07-28", command: process.execPath, args: [resolve(import.meta.dir, "../../packages/core/test/helpers/mcp-server.ts")] } } } }));
	const decoder = new TextDecoder(); const terminal = new Bun.Terminal({ cols: 180, rows: 48, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } });
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../packages/cli/src/main.ts"), "--no-skills"], { cwd, terminal, env: { PATH: process.env.PATH, HOME: cwd, TERM: "xterm-256color", XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data") } });
	const wait = async (text: string) => bounded((async () => { while (!output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").includes(text)) { if (child.exitCode !== null) throw new Error(`PTY exited: ${output.slice(-1600)}`); await Bun.sleep(10); } })(), `MCP PTY ${text}`).catch(error => { throw new Error(`${error}: ${output.slice(-4000)}`); });
	try {
		await wait("ctrl+c"); terminal.write("/mcp tools fixture\r"); await wait("remoteName"); expect(fixture.count).toBe(0);
		terminal.write('/mcp use-prompt fixture template --args \'{"subject":"PTY"}\' -- MCP_TASK\r'); await wait("Permission: mcp_get_prompt"); terminal.write("\r"); await wait("MCP_PROMPT_COMPLETE");
		output = ""; terminal.write("Run form\r"); await wait(`Permission: ${mcpToolName("fixture", "form")}`); terminal.write("\r"); await wait("Choose count");
		terminal.write("7\x10"); await wait("parked"); terminal.write("\t\t\r"); await wait("MCP_FORM_COMPLETE");
		output = ""; terminal.write("Run cancel\r"); await wait(`Permission: ${mcpToolName("fixture", "form")}`); terminal.write("\r"); await wait("Choose count"); terminal.write("\x1b"); await wait("MCP_CANCEL_COMPLETE");
        output = ""; terminal.write("/new\r"); await wait("Type a message"); terminal.write("/mcp status\r"); await wait('"ready"');
        terminal.write("/quit\r"); expect(await bounded(child.exited, "MCP PTY exit")).toBe(0); expect(output).toContain("\x1b[?1049l"); await fixture.verify();
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
}, 20000);
