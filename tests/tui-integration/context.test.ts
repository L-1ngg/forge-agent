import { expect, test } from "bun:test";
import { PtyDriver } from "../support/pty.ts";
import { withScenario } from "../support/scenario.ts";

test("PTY compact uses the SDK, stays idle and never streams summary as an answer", async () => withScenario("PTY compact uses the SDK, stays idle and never streams summary as an answer", async scenario => {
	let ready = false, compacted = false, completed = false;
	let final: { raw?: boolean; compactions?: number } = {};

	const pty = new PtyDriver(["tests/tui-integration/context.fixture.ts"], { columns: 80, rows: 24, ipc(message) {
		if (message === "ready") ready = true;
		if (message === "task-done") completed = true;
		if (message && typeof message === "object" && "compact" in message) compacted = message.compact === "complete";
		if (message && typeof message === "object" && "raw" in message) final = message as typeof final;
	} });
	scenario.defer(() => pty.close());
	const terminal = pty, child = pty.child;
	const waitFor = pty.waitFor.bind(pty);
	await waitFor(() => ready);
	terminal.write("/compact preserve the goal\r");
	await waitFor(() => compacted);
	expect(completed).toBe(false);
	expect(pty.text).not.toContain("PRIVATE_CHECKPOINT_SUMMARY");
	terminal.resize(40, 12);
	terminal.write("continue\r");
	await waitFor(() => completed);
	await waitFor(() => pty.text.includes("AFTER_COMPACT"));
	expect(pty.text).toContain("AFTER_COMPACT");
	terminal.write("\x03");
	await waitFor(() => child.exitCode !== null);
	expect(await child.exited).toBe(0);
	expect(final).toMatchObject({ raw: false, compactions: 1 });
}, { timeoutMs: 26000 }), 35_000);
