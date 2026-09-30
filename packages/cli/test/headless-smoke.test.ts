import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withScenario, bounded } from "../../../tests/support/scenario.ts";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";

test("formal headless CLI emits JSON and settles exactly one deferred memory call before exit", () => withScenario("headless-smoke", async scenario => {
	const fixture = scenario.httpFixture(scenario.id, [
		{ id: "task", method: "POST", path: "/v1/messages", match(body) {
			expect(JSON.stringify(body)).toContain("headless smoke");
		}, response: { chunks: [await modelResponse([], "end_turn", "replay ok").text()] } },
		{ id: "memory", method: "POST", path: "/v1/messages", match(body) {
			expect(JSON.stringify(body)).toContain("Maintain concise long-term Markdown memory.");
		}, response: { chunks: [await modelResponse([], "end_turn", '{"updates":[],"indexes":[]}').text()] } },
	]);
	await mkdir(join(scenario.cwd, ".forge-agent"));
	await Bun.write(join(scenario.cwd, ".forge-agent/config.json"), JSON.stringify({ apiKey: "local-test", baseUrl: fixture.url }));
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "-p", "headless smoke", "--json", "--no-skills", "--provider", "anthropic", "--model", "claude-sonnet-4-5"], {
		cwd: scenario.cwd, env: { ...process.env, ...scenario.env, FORGE_AGENT_API_KEY: "", FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "" }, stdout: "pipe", stderr: "pipe",
	});
	scenario.defer(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await bounded(child.exited, "headless child cleanup"); });
	const [stdout, stderr, code] = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), "headless output and exit");
	if (code !== 0) throw new Error(`Headless CLI exited ${code}: ${stderr}\n${stdout}`);
	const events = stdout.trim().split("\n").map(line => JSON.parse(line));
	expect(events.some(event => event.type === "message_end" && JSON.stringify(event).includes("replay ok"))).toBe(true);
	expect(events.filter(event => event.type === "memory" && event.phase === "save")).toMatchObject([{ status: "skipped", calls: 1 }]);
	expect(fixture.count).toBe(2);
}));
