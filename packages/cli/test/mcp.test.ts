import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "@forge-agent/core";
import { parseMcpCommand, mcpInput, persistMcpEnabled } from "../src/mcp-command.ts";
import { FileMcpArtifactStore } from "../src/mcp-host.ts";

test("MCP configuration uses whole-server replacement, source-relative cwd, and parses literal prompt JSON/task", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-cli-"));
	try { await mkdir(join(cwd, "global/forge-agent"), { recursive: true }); await mkdir(join(cwd, ".forge-agent"));
		await writeFile(join(cwd, "global/forge-agent/config.json"), JSON.stringify({ mcp: { servers: { files: { transport: "stdio", command: "old", args: ["old"] }, remote: { transport: "http", url: "https://example.test/mcp" } } } }));
		await writeFile(join(cwd, ".forge-agent/config.json"), JSON.stringify({ systemPrompt: "keep", mcp: { servers: { files: { transport: "stdio", command: "new", cwd: ".." } } } }));
		const config = await loadConfig({ cwd, home: cwd, env: { XDG_CONFIG_HOME: join(cwd, "global") } }); expect(config.mcp?.servers.files?.command).toBe("new"); expect(config.mcp?.servers.files?.args).toBeUndefined(); expect(config.mcp?.servers.files?.cwd).toBe(cwd); expect(config.mcp?.servers.remote).toBeDefined();
		await persistMcpEnabled(cwd, config, parseMcpCommand("disable files --scope project")); const saved = JSON.parse(await readFile(join(cwd, ".forge-agent/config.json"), "utf8")); expect(saved.systemPrompt).toBe("keep"); expect(saved.mcp.servers.files.enabled).toBe(false);
		const input = mcpInput('/mcp use-prompt files greet --args \'{"name":"a -- b"}\' --   task "raw"\nnext  '); expect(input).toEqual({ kind: "mcp_prompt", serverId: "files", name: "greet", arguments: { name: "a -- b" }, task: '  task "raw"\nnext  ' });
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("formal MCP CLI status needs no model and releases a real stdio server", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-command-"));
	try { await mkdir(join(cwd, ".forge-agent")); await writeFile(join(cwd, ".forge-agent/config.json"), JSON.stringify({ mcp: { servers: { fixture: { transport: "stdio", command: process.execPath, args: [resolve(import.meta.dir, "../../core/test/helpers/mcp-server.ts")] } } } }));
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "--json", "--mcp", "status"], { cwd, env: { PATH: process.env.PATH, HOME: cwd, XDG_CONFIG_HOME: join(cwd, "config") }, stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); expect(JSON.parse(stdout).result.servers[0].state).toBe("ready"); expect(stdout).not.toContain("apiKey");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("CLI attachments are immutable across reopening and missing never fetches remote", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-artifact-"));
	try { const store = new FileMcpArtifactStore(cwd); const reference = await store.put(Buffer.from("saved bytes"), { mimeType: "audio/wav" }); const reopened = new FileMcpArtifactStore(cwd); expect(Buffer.from((await reopened.read(reference.id)).bytes).toString()).toBe("saved bytes"); await store.delete(reference.id); await expect(reopened.read(reference.id)).rejects.toThrow("missing"); await expect(reopened.read("../../config.json")).rejects.toThrow(); }
	finally { await rm(cwd, { recursive: true, force: true }); }
});

import { RequestBus } from "@forge-agent/core";
import { browserMcpInteraction } from "../src/mcp-host.ts";
test("CLI OAuth callback verifies state, Continue is not authentication, cancel closes listener", async () => {
	const bus = new RequestBus(); const signal = new AbortController();
	const adapter = browserMcpInteraction(bus, async () => {}); const interaction = await adapter.beginAuthorization({ serverId: "fixture", operationId: "op", signal: signal.signal });
	const url = new URL("https://fixture.invalid/authorize?state=expected"); let completed = false; const pending = interaction.authorize(url).then(result => { completed = true; return result; });
	try { const request = await bus.requests()[Symbol.asyncIterator]().next(); expect(request.value?.kind).toBe("oauth"); bus.respond({ type: "response", id: request.value!.id, result: { decision: "completed" } }); await new Promise(resolve => setTimeout(resolve, 10)); expect(completed).toBe(false); expect((await fetch(interaction.redirectUri + "?state=wrong&code=fixture")).status).toBe(400); expect(completed).toBe(false); expect((await fetch(interaction.redirectUri + "?state=expected&code=fixture")).status).toBe(200); expect((await pending).get("code")).toBe("fixture"); expect((await fetch(interaction.redirectUri + "?state=expected&code=fixture")).status).toBe(400); }
	finally { await interaction.close(); bus.close(); }
	await expect(fetch(interaction.redirectUri)).rejects.toThrow();
});

test("MCP artifact export finds a prior session and refuses overwriting a user file", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-export-"));
	try {
		const { McpManager } = await import("@forge-agent/core"); const { ProjectMcpArtifactStore } = await import("../src/mcp-host.ts"); const { mcpCommand } = await import("../src/mcp-command.ts");
		const source = new FileMcpArtifactStore(join(cwd, "artifacts", "session")); const reference = await source.put(Buffer.from("original"), { mimeType: "text/plain" });
		const manager = new McpManager({ servers: {}, artifacts: new ProjectMcpArtifactStore(join(cwd, "artifacts")) }, { cwd, permission: { rules: [{ tool: "mcp_read_artifact", argsPattern: "*", effect: "allow" }] } });
		try { (await manager.prepare({ servers: {} }, [])).commit(0); const output = join(cwd, "export.txt"); await mcpCommand(manager, `artifact ${reference.id} --output ${output}`, () => {}); expect(await readFile(output, "utf8")).toBe("original"); await writeFile(output, "user edit"); await expect(mcpCommand(manager, `artifact ${reference.id} --output ${output}`, () => {})).rejects.toThrow(); expect(await readFile(output, "utf8")).toBe("user edit"); }
		finally { await manager.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("MCP standalone invalid commands exit 2 before creating connections", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-args-"));
	try {
		for (const command of ["unknown", "read", "disable fixture", "prompt server name --args invalid"]) {
			const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "--json", "--mcp", command], { cwd, env: { PATH: process.env.PATH, HOME: cwd, XDG_CONFIG_HOME: join(cwd, "config") }, stdout: "pipe", stderr: "pipe" });
			await new Response(child.stdout).text(); expect(await child.exited).toBe(2);
		}
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("production MCP credential lock serializes different processes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-mcp-lock-"));
	const { SystemMcpCredentialStore } = await import("../src/mcp-host.ts"); const store = new SystemMcpCredentialStore("linux-keyutils", join(cwd, "locks"), "forge-test-lock");
	let release!: () => void, acquired!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { acquired = resolve; });
	const first = store.withLock("synthetic", async () => { acquired(); await gate; }); await ready;
	const script = join(cwd, "compete.ts"); await writeFile(script, `import { SystemMcpCredentialStore } from ${JSON.stringify(resolve(import.meta.dir, "../src/mcp-host.ts"))}; const store = new SystemMcpCredentialStore("linux-keyutils", process.argv[2], "forge-test-lock"); console.log("waiting"); await store.withLock("synthetic", async () => { console.log("acquired"); });`);
	const child = Bun.spawn([process.execPath, script, join(cwd, "locks")], { stdout: "pipe", stderr: "pipe" });
	let output = ""; const consume = (async () => { for await (const bytes of child.stdout) output += Buffer.from(bytes).toString(); })();
	try { const deadline = Date.now() + 2000; while (!output.includes("waiting") && Date.now() < deadline) await Bun.sleep(5); expect(output).toContain("waiting"); await Bun.sleep(50); expect(output).not.toContain("acquired"); release(); await first; expect(await child.exited).toBe(0); await consume; expect(output).toContain("acquired"); }
	finally { release(); await first; if (child.exitCode === null) child.kill(); await child.exited; await consume; await rm(cwd, { recursive: true, force: true }); }
});
