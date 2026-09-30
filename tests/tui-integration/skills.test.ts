import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { modelResponse } from "../fixtures/model-response.ts";
import { bounded } from "../support/control.ts";
import { PtyDriver } from "../support/pty.ts";
import { withScenario } from "../support/scenario.ts";

test("formal CLI PTY lists/reloads, completes explicit-only skill, submits once, restores failed draft and exits", async () => withScenario("formal CLI PTY lists/reloads, completes explicit-only skill, submits once, restores failed draft and exits", async scenario => {
	const cwd = scenario.cwd;
	const fixture = scenario.httpFixture("skills-pty", [{ id: "selected", method: "POST", path: "/v1/messages", match(body) { const text = JSON.stringify(body); expect(text).toContain("PTY_BODY"); expect(text).toContain("PTY_TASK"); }, response: { chunks: [await modelResponse([], "end_turn", "PTY_COMPLETED").text()] } }]);
	await mkdir(join(cwd, ".forge/skills/manual"), { recursive: true }); await mkdir(join(cwd, ".forge-agent"), { recursive: true });
	await writeFile(join(cwd, ".forge/skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual instructions\ndisable-model-invocation: true\n---\nPTY_BODY");
	await writeFile(join(cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: fixture.url, memory: { autoUpdate: false, injection: false }, skills: { roots: { user: ".forge/skills", builtin: ".forge/skills" } } }));

	const pty = new PtyDriver([resolve(import.meta.dir, "../../packages/cli/src/main.ts")], { columns: 180, rows: 48, cwd, env: { PATH: process.env.PATH, TERM: "xterm-256color", XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data") } });
	scenario.defer(() => pty.close());
	const terminal = pty, child = pty.child;
	const waitFor = (text: string) => pty.waitFor(() => pty.screenText.includes(text), text);
	await waitFor("ctrl+c");
	terminal.write("/skills \r"); await waitFor("explicit-only"); expect(fixture.count).toBe(0);
	terminal.write("/skills reload\r"); await waitFor("Skills applied");
	pty.clear(); terminal.write("/skill ma"); await waitFor("manual  Manual instructions");
	terminal.write("\r"); await waitFor("❯ /skill manual");
	terminal.write("PTY_TASK\r");
	await fixture.received(1).catch(error => { throw new Error(`${error}: ${pty.text.slice(-5000)}`); }); await waitFor("PTY_COMPLETED");
	terminal.write("/skill missing RESTORE_ME\r"); await waitFor("unknown-skill");
	// Clear the returned editable draft with backspaces, then quit. No extra request is permitted.
	terminal.write("\x7f".repeat(80) + "/quit\r");
	expect(await bounded(child.exited, "PTY exit")).toBe(0);
	expect(pty.text).toContain("\x1b[?1049l");
}, { timeoutMs: 26000 }), 35_000);
