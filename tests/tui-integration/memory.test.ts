import { expect, test } from "bun:test";
import { PtyDriver } from "../support/pty.ts";
import { withScenario } from "../support/scenario.ts";

test("PTY /memory saves, reads, edits and deletes without starting model work or leaving raw mode", async () => withScenario("PTY /memory saves, reads, edits and deletes without starting model work or leaving raw mode", async scenario => {
	let ready = false;
	const results: Array<{ command: string; text: string }> = [];
	let final: { raw?: boolean; calls?: number; files?: string[] } = {};

	const pty = new PtyDriver(["tests/tui-integration/memory.fixture.ts"], { columns: 120, rows: 36, env: { ...process.env, FORGE_AGENT_PTY_DIRECTORY: scenario.cwd }, ipc(message) {
		if (message === "ready") ready = true;
		if (message && typeof message === "object" && "command" in message) results.push(message as { command: string; text: string });
		if (message && typeof message === "object" && "raw" in message) final = message as typeof final;
	} });
	scenario.defer(() => pty.close());
	const terminal = pty, child = pty.child;
	const until = pty.waitFor.bind(pty);
	await until(() => ready);
	for (const command of ["save project pty.md MEMORY_PTY_ORIGINAL", "read project pty.md", "edit project pty.md MEMORY_PTY_CORRECTION", "read project pty.md", "delete project pty.md"]) {
		const completed = results.length;
		await pty.send(`/memory ${command}\r`);
		await until(() => results.length > completed);
		await until(async () => (await pty.frameText()).replace(/\s/g, "").includes(results.at(-1)!.text.replace(/\s/g, "")), "memory result visible after management settlement");
	}
	expect(results[1]?.text).toContain("MEMORY_PTY_ORIGINAL");
	expect(results[3]?.text).toContain("MEMORY_PTY_CORRECTION");
	expect(pty.text).toContain("会话历史");
	terminal.resize(60, 18);
	terminal.write("/quit\r"); await child.exited;
	expect(child.exitCode).toBe(0); expect(final).toMatchObject({ raw: false, calls: 0, files: [] });
}, { timeoutMs: 26000 }), 35_000);
