import { expect, test } from "bun:test";

test("PTY: transient retry shows progress and successful completion without stopping the next input", async () => {
	let output = ""; const messages: unknown[] = [];
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 100, rows: 32, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/retry.fixture.ts"], { terminal, ipc(message) { messages.push(message); } });
	const waitFor = async (condition: () => boolean) => {
		for (let i = 0;i < 500;i++) { if (condition()) return; if (child.exitCode !== null) throw new Error(`Child exited: ${output.slice(-1000)}`); await Bun.sleep(10); }
		throw new Error(`Timed out: ${output.slice(-1000)}`);
	};
	try {
		await waitFor(() => messages.includes("ready")); terminal.write("first\r");
		await waitFor(() => messages.some(message => typeof message === "object" && message !== null && "calls" in message && message.calls === 2));
		expect(messages).toContainEqual({ status: "success", calls: 2 });
		expect(output).toContain("Model retry scheduled #1"); expect(output).toContain("success");
		terminal.write("next\r");
		await waitFor(() => messages.some(message => typeof message === "object" && message !== null && "calls" in message && message.calls === 3));
		expect(messages).toContainEqual({ status: "success", calls: 3 });
		terminal.write("\x03"); await waitFor(() => child.exitCode !== null);
		expect(await child.exited).toBe(0); expect(messages).toContainEqual({ raw: false });
		expect(output).toContain("\x1b[?1049l");
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); }
}, 15000);
