import { expect, test } from "bun:test";

test("PTY compact uses the SDK, stays idle and never streams summary as an answer", async () => {
	let output = "", ready = false, compacted = false, completed = false;
	let final: { raw?: boolean; compactions?: number } = {};
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 80, rows: 24, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/context.fixture.ts"], { terminal, ipc(message) {
		if (message === "ready") ready = true;
		if (message === "task-done") completed = true;
		if (message && typeof message === "object" && "compact" in message) compacted = message.compact === "complete";
		if (message && typeof message === "object" && "raw" in message) final = message;
	} });
	const waitFor = async (condition: () => boolean) => {
		for (let count = 0; count < 500; count++) { if (condition()) return; if (child.exitCode !== null) throw new Error(`PTY exited: ${output.slice(-500)}`); await Bun.sleep(10); }
		throw new Error(`PTY timeout: ${output.slice(-500)}`);
	};
	try {
		await waitFor(() => ready);
		terminal.write("/compact preserve the goal\r");
		await waitFor(() => compacted);
		expect(completed).toBe(false);
		expect(output).not.toContain("PRIVATE_CHECKPOINT_SUMMARY");
		terminal.resize(40, 12); child.kill("SIGWINCH");
		terminal.write("continue\r");
		await waitFor(() => completed);
		expect(output).toContain("AFTER_COMPACT");
		terminal.write("\x03");
		await waitFor(() => child.exitCode !== null);
		expect(await child.exited).toBe(0);
		expect(final).toMatchObject({ raw: false, compactions: 1 });
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); }
}, 10000);
