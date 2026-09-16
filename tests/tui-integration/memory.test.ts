import { expect, test } from "bun:test";

test("PTY /memory saves, reads, edits and deletes without starting model work or leaving raw mode", async () => {
	let output = "", ready = false;
	const results: Array<{ command: string; text: string }> = [];
	let final: { raw?: boolean; calls?: number; files?: string[] } = {};
	const terminal = new Bun.Terminal({ cols: 120, rows: 36, data(_terminal, bytes) { output += new TextDecoder().decode(bytes); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/memory.fixture.ts"], { terminal, ipc(message) {
		if (message === "ready") ready = true;
		if (message && typeof message === "object" && "command" in message) results.push(message as { command: string; text: string });
		if (message && typeof message === "object" && "raw" in message) final = message;
	} });
	const until = async (check: () => boolean) => { for (let i = 0; i < 500; i++) { if (check()) return; if (child.exitCode !== null) throw new Error(output.slice(-500)); await Bun.sleep(10); } throw new Error(`Memory PTY timeout: ${output.slice(-500)}`); };
	try {
		await until(() => ready);
		for (const command of ["save project pty.md MEMORY_PTY_ORIGINAL", "read project pty.md", "edit project pty.md MEMORY_PTY_CORRECTION", "read project pty.md", "delete project pty.md"]) {
			const completed = results.length;
			terminal.write(`/memory ${command}\r`);
			await until(() => results.length > completed);
			await Bun.sleep(20);
		}
		expect(results[1]?.text).toContain("MEMORY_PTY_ORIGINAL");
		expect(results[3]?.text).toContain("MEMORY_PTY_CORRECTION");
		expect(output).toContain("会话历史");
		terminal.resize(60, 18); child.kill("SIGWINCH");
		terminal.write("/quit\r"); await child.exited;
		expect(child.exitCode).toBe(0); expect(final).toMatchObject({ raw: false, calls: 0, files: [] });
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); }
}, 15000);
