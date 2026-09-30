import { expect, test } from "bun:test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { modelResponse } from "../fixtures/model-response.ts";
import { PtyDriver } from "../support/pty.ts";
import { bounded, withScenario } from "../support/scenario.ts";

test("formal CLI PTY permission allow writes once, deny preserves the real file", () => withScenario("cli-permission", async scenario => {
	const allowed = await modelResponse([{ id: "allow-write", name: "write", arguments: { path: "result.txt", content: "authorized" } }]).text();
	const denied = await modelResponse([{ id: "deny-write", name: "write", arguments: { path: "result.txt", content: "forbidden" } }]).text();
	const fixture = scenario.httpFixture(scenario.id, [
		{ id: "allow", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("allow this"); }, response: { chunks: [allowed] } },
		{ id: "continued", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("allow-write"); expect(JSON.stringify(body)).toContain("tool_result"); }, response: { chunks: [await modelResponse([], "end_turn", "CLI_WRITE_COMPLETE").text()] } },
		{ id: "deny", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("deny this"); }, response: { chunks: [denied] } },
		{ id: "denied-continuation", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("Denied by user"); }, response: { chunks: [await modelResponse([], "end_turn", "CLI_DENIAL_COMPLETE").text()] } },
	]);
	await mkdir(join(scenario.cwd, ".forge-agent"));
	await Bun.write(join(scenario.cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", baseUrl: fixture.url, thinkingLevel: "off", retry: { enabled: false }, memory: { autoUpdate: false, injection: false } }));

	const pty = new PtyDriver([resolve(import.meta.dir, "../../packages/cli/src/main.ts")], { columns: 110, rows: 32, cwd: scenario.cwd, env: { ...process.env, ...scenario.env, FORGE_AGENT_API_KEY: "", FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "" } });
	const terminal = pty, child = pty.child;
	scenario.defer(() => pty.close());
	const wait = pty.waitFor.bind(pty);
	const send = (text: string) => { pty.clear(); terminal.write(`\x1b[200~${text}\x1b[201~\r`); };
	await wait(() => pty.text.includes("Type a message")); send("allow this");
	await wait(() => pty.text.includes("Permission: write"));
	expect(await Bun.file(join(scenario.cwd, "result.txt")).exists()).toBe(false);
	terminal.write("\r");
	await wait(() => pty.text.includes("CLI_WRITE_COMPLETE"));
	expect(await readFile(join(scenario.cwd, "result.txt"), "utf8")).toBe("authorized");
	send("deny this"); await wait(() => pty.text.includes("Permission: write"));
	terminal.write("\x1b[B\x1b[B\r");
	await wait(async () => {
		const directory = join(scenario.cwd, ".forge-agent/sessions");
		for (const file of await readdir(directory)) if ((await readFile(join(directory, file), "utf8")).includes("Denied by user")) return true;
		return false;
	});
	expect(await readFile(join(scenario.cwd, "result.txt"), "utf8")).toBe("authorized");
	terminal.write("\x03"); expect(await bounded(child.exited, "CLI exit")).toBe(0);
	expect(pty.text).toContain("\x1b[?2004l");
}), 15_000);

test("PTY parked approval preserves queued input when stop-and-send replaces the task", () => withScenario("cli-permission-stop", async scenario => {
	const proposal = await modelResponse([{ id: "pending-write", name: "write", arguments: { path: "result.txt", content: "must not write" } }]).text();
	const fixture = scenario.httpFixture(scenario.id, [
		{ id: "proposal", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("original task"); }, response: { chunks: [proposal] } },
		{ id: "replacement", method: "POST", path: "/v1/messages", match(body) {
			const text = JSON.stringify(body);
			expect(text).toContain("chosen task");
			expect(text).not.toContain("queued task");
		}, response: { chunks: [await modelResponse([], "end_turn", "REPLACEMENT_COMPLETE").text()] } },
	]);
	await mkdir(join(scenario.cwd, ".forge-agent"));
	await Bun.write(join(scenario.cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", baseUrl: fixture.url, thinkingLevel: "off", retry: { enabled: false }, memory: { autoUpdate: false, injection: false } }));

	const pty = new PtyDriver([resolve(import.meta.dir, "../../packages/cli/src/main.ts")], { columns: 110, rows: 32, cwd: scenario.cwd, env: { ...process.env, ...scenario.env, FORGE_AGENT_API_KEY: "", FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "" } });
	const terminal = pty, child = pty.child;
	scenario.defer(() => pty.close());
	const wait = (text: string) => pty.waitFor(() => pty.screenText.includes(text), text);
	await wait("Type a message");
	terminal.write("original task\r");
	await wait("Permission: write");
	expect(await Bun.file(join(scenario.cwd, "result.txt")).exists()).toBe(false);
	terminal.write("\x1b"); await wait("parked");
	terminal.write("cqueued task\r");
	await wait("Queued 1: queued task");
	terminal.write("chosen task\x1b[13;5u");
	await wait("REPLACEMENT_COMPLETE");
	expect(await Bun.file(join(scenario.cwd, "result.txt")).exists()).toBe(false);
	const directory = join(scenario.cwd, ".forge-agent/sessions");
	const saved = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), "utf8")))).join("\n");
	expect(saved).toContain("chosen task");
	expect(saved).not.toContain('"text":"queued task"');
	expect(pty.text).toContain("queued task");
	terminal.write("\x03");
	expect(await bounded(child.exited, "CLI exit")).toBe(0);
}), 15_000);
