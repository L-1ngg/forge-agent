import { expect, test } from "bun:test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withScenario, bounded } from "../support/scenario.ts";
import { modelResponse } from "../../packages/core/test/helpers/model-response.ts";

test("formal CLI PTY permission allow writes once, deny preserves the real file", () => withScenario("cli-permission", async scenario => {
	const allowed = await modelResponse([{ id: "allow-write", name: "write", arguments: { path: "result.txt", content: "authorized" } }]).text();
	const denied = await modelResponse([{ id: "deny-write", name: "write", arguments: { path: "result.txt", content: "forbidden" } }]).text();
	const fixture = scenario.httpFixture(scenario.id, [
		{ id: "allow", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("allow this"); }, response: { chunks: [allowed] } },
		{ id: "continued", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("allow-write"); expect(JSON.stringify(body)).toContain("tool_result"); }, response: { chunks: [await modelResponse([], "end_turn", "CLI_WRITE_COMPLETE").text()] } },
		{ id: "deny", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("deny this"); }, response: { chunks: [denied] } },
	]);
	await mkdir(join(scenario.cwd, ".forge-agent"));
	await Bun.write(join(scenario.cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", baseUrl: fixture.url, thinkingLevel: "off", retry: { enabled: false }, memory: { autoUpdate: false, injection: false } }));
	let output = "";
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 110, rows: 32, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
	scenario.defer(() => terminal.close());
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../packages/cli/src/main.ts")], { cwd: scenario.cwd, terminal, env: { ...process.env, ...scenario.env, FORGE_AGENT_API_KEY: "", FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "" } });
	scenario.defer(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
	const wait = async (check: () => boolean | Promise<boolean>) => bounded((async () => {
		while (!await check()) { if (child.exitCode !== null) throw new Error(`CLI exited: ${output.slice(-1500)}`); await Bun.sleep(10); }
	})(), "CLI permission", 6000);
	const send = (text: string) => { output = ""; terminal.write(`\x1b[200~${text}\x1b[201~\r`); };
	await wait(() => output.includes("Type a message")); send("allow this");
	await wait(() => output.includes("Permission: write"));
	expect(await Bun.file(join(scenario.cwd, "result.txt")).exists()).toBe(false);
	terminal.write("\r");
	await wait(() => output.includes("CLI_WRITE_COMPLETE"));
	expect(await readFile(join(scenario.cwd, "result.txt"), "utf8")).toBe("authorized");
	send("deny this"); await wait(() => output.includes("Permission: write"));
	terminal.write("\x1b[B\x1b[B\r");
	await wait(async () => {
		const directory = join(scenario.cwd, ".forge-agent/sessions");
		for (const file of await readdir(directory)) if ((await readFile(join(directory, file), "utf8")).includes("Denied by user")) return true;
		return false;
	});
	expect(await readFile(join(scenario.cwd, "result.txt"), "utf8")).toBe("authorized");
	terminal.write("\x03"); expect(await bounded(child.exited, "CLI exit")).toBe(0);
	expect(output).toContain("\x1b[?2004l");
}), 15_000);
