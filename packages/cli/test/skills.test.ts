import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { HttpFixture } from "../../../tests/support/http-fixture.ts";
import { modelResponse } from "../../core/test/helpers/model-response.ts";
import { skillInput, cliSkills } from "../src/skills-command.ts";
import { createInputCompletionSource } from "../../core/src/input/completion.ts";
const entry = resolve(import.meta.dir, "../src/main.ts");
test("formal CLI lists, reloads, selects and disables Skills with valid JSON and no management history", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-cli-skills-"));
	const fixture = new HttpFixture("cli-skills", [{ id: "selected", method: "POST", path: "/v1/messages", match(body) {
		const request = body as { messages: Array<{ content: Array<{ text: string }> }> };
		expect(request.messages[0]!.content[0]!.text).toContain("CLI_BODY");
		expect(request.messages[0]!.content[0]!.text.endsWith('  task "literal"\nnext  ')).toBe(true);
	}, response: { chunks: [await modelResponse().text()] } }]);
	try {
		await mkdir(join(cwd, ".forge/skills/manual"), { recursive: true }); await mkdir(join(cwd, ".forge-agent"), { recursive: true });
		await writeFile(join(cwd, ".forge/skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual workflow\ndisable-model-invocation: true\n---\nCLI_BODY");
		const config = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: fixture.url, skills: { roots: { user: ".forge/skills", builtin: ".forge/skills" } } };
		const configPath = join(cwd, ".forge-agent/config.json"); await writeFile(configPath, JSON.stringify(config));
		const run = async (prompt: string, extra: string[] = []) => {
			const child = Bun.spawn([process.execPath, entry, "--json", "-p", prompt, ...extra], { cwd, env: { PATH: process.env.PATH, XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data") }, stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect(err).toBe(""); return { code, rows: out.trim().split("\n").map(line => JSON.parse(line)) };
		};
		const listed = await run("/skills"); expect(listed.code).toBe(0); expect(listed.rows[0].entries[0]).toMatchObject({ name: "manual", layer: "workspace", status: "available" });
		expect((await run("/skills reload")).rows.map(row => row.phase)).toEqual(["accepted", "applied"]);
		expect(await readdir(join(cwd, ".forge-agent"))).toEqual(["config.json"]);
		expect((await run("/skills", ["--no-skills"])).rows[0]).toMatchObject({ enabled: false, entries: [] });
		const missing = await run("/skill absent task"); expect(missing.code).toBe(1); expect(missing.rows.some(row => row.type === "skill_input" && row.code === "unknown-skill")).toBe(true);
		const selected = await run('/skill manual   task "literal"\nnext  '); expect(selected.code).toBe(0);
		await writeFile(configPath, JSON.stringify({ ...config, permissionMode: "deny-all" }));
		const disabled = await run("/skill manual disabled", ["--no-skills"]); expect(disabled.code).toBe(1); expect(disabled.rows.some(row => row.code === "skills-disabled")).toBe(true);
		await fixture.verify();
	} finally { fixture.close(); await rm(cwd, { recursive: true, force: true }); }
}, 15000);

test("CLI resolves worktree defaults and distributed builtin directory, and completion includes explicit-only names", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-paths-"));
	try {
		const roots = (await cliSkills(cwd, undefined, false)).roots;
		expect(roots.workspace?.path).toBe(join(cwd, ".forge/skills")); expect(roots.user?.path).toEndWith("/.forge/skills");
		expect(await readdir(roots.builtin!.path)).toContain(".gitkeep");
		const source = createInputCompletionSource({ listSkills: () => [{ name: "manual", description: "Explicit-only" }] });
		const suggestions = await source.getSuggestions("/skill ma", 9); expect(suggestions?.items[0]?.value).toBe("manual");
		expect(source.applyCompletion("/skill ma", 9, suggestions!.items[0]!, suggestions!.prefix).input).toBe("/skill manual ");
		expect(skillInput("/skill manual   x\ny  ")).toEqual({ kind: "skill", name: "manual", task: "  x\ny  " });
	} finally { await rm(cwd, { recursive: true, force: true }); }
});
