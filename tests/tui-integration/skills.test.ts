import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HttpFixture } from "../support/http-fixture.ts";
import { modelResponse } from "../../packages/core/test/helpers/model-response.ts";
import { bounded } from "../support/control.ts";

test("formal CLI PTY lists/reloads, completes explicit-only skill, submits once, restores failed draft and exits", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skill-pty-")); let output = "";
	const fixture = new HttpFixture("skills-pty", [{ id: "selected", method: "POST", path: "/v1/messages", match(body) { const text = JSON.stringify(body); expect(text).toContain("PTY_BODY"); expect(text).toContain("PTY_TASK"); }, response: { chunks: [await modelResponse([], "end_turn", "PTY_COMPLETED").text()] } }]);
	await mkdir(join(cwd, ".forge/skills/manual"), { recursive: true }); await mkdir(join(cwd, ".forge-agent"), { recursive: true });
	await writeFile(join(cwd, ".forge/skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual instructions\ndisable-model-invocation: true\n---\nPTY_BODY");
	await writeFile(join(cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: fixture.url, memory: { autoUpdate: false, injection: false }, skills: { roots: { user: ".forge/skills", builtin: ".forge/skills" } } }));
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 180, rows: 48, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } });
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../packages/cli/src/main.ts")], { cwd, terminal, env: { PATH: process.env.PATH, TERM: "xterm-256color", XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data") } });
	const waitFor = async (text: string) => bounded((async () => { while (!output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").includes(text)) { if (child.exitCode !== null) throw new Error(`PTY exited: ${output.slice(-1200)}`); await Bun.sleep(10); } })(), `PTY ${text}`).catch(error => { throw new Error(`${error}: ${output.slice(-2500)}`); });
	try {
		await waitFor("ctrl+c");
		terminal.write("/skills\r"); await waitFor("explicit-only"); expect(fixture.count).toBe(0);
		terminal.write("/skills reload\r"); await waitFor("Skills applied");
		output = ""; terminal.write("/skill ma"); await waitFor("Manual instructions"); terminal.write("\rPTY_TASK\r");
		await fixture.received(1).catch(error => { throw new Error(`${error}: ${output.slice(-5000)}`); }); await waitFor("PTY_COMPLETED");
		terminal.write("/skill missing RESTORE_ME\r"); await waitFor("unknown-skill");
		// Clear the returned editable draft with backspaces, then quit. No extra request is permitted.
		terminal.write("\x7f".repeat(80) + "/quit\r");
		expect(await bounded(child.exited, "PTY exit")).toBe(0);
		expect(output).toContain("\x1b[?1049l"); await fixture.verify();
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
}, 20000);
