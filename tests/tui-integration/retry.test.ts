import { expect, test } from "bun:test";
import { PtyDriver } from "../support/pty.ts";
import { withScenario } from "../support/scenario.ts";

test("PTY: transient retry shows progress and successful completion without stopping the next input", async () => withScenario("PTY: transient retry shows progress and successful completion without stopping the next input", async scenario => {
	 const messages: unknown[] = [];

	const pty = new PtyDriver(["tests/tui-integration/retry.fixture.ts"], { columns: 100, rows: 32, ipc(message) { messages.push(message); } });
	scenario.defer(() => pty.close());
	const terminal = pty, child = pty.child;
	const waitFor = pty.waitFor.bind(pty);
	await waitFor(() => messages.includes("ready")); terminal.write("first\r");
	await waitFor(() => messages.some(message => typeof message === "object" && message !== null && "calls" in message && message.calls === 2));
	expect(messages).toContainEqual({ status: "success", calls: 2 });
	await waitFor(() => pty.text.includes("Model retry scheduled #1") && pty.text.includes("success"));
	expect(pty.text).toContain("Model retry scheduled #1"); expect(pty.text).toContain("success");
	terminal.write("next\r");
	await waitFor(() => messages.some(message => typeof message === "object" && message !== null && "calls" in message && message.calls === 3));
	expect(messages).toContainEqual({ status: "success", calls: 3 });
	terminal.write("\x03"); await waitFor(() => child.exitCode !== null);
	expect(await child.exited).toBe(0); expect(messages).toContainEqual({ raw: false });
	expect(pty.text).toContain("\x1b[?1049l");
}, { timeoutMs: 26000 }), 35_000);
