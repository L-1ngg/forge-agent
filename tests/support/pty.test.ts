import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { bounded } from "./control.ts";
import { PtyDriver } from "./pty.ts";
import { withScenario } from "./scenario.ts";

test("PTY screen combines differential writes and removes text erased by a later paint", async () => {
	const pty = new PtyDriver(["-e", 'process.stdout.write("\\x1b[2J\\x1b[HOLD_TITLE\\x1b[2;1HPREVIEW_TOP\\x1b[2;2HREVIEW_BOTTOM\\x1b[H\\x1b[2KNEW_TITLE"); setInterval(() => {}, 1000);']);
	try {
		await pty.waitFor(() => pty.screenText.includes("NEW_TITLE") && pty.screenText.includes("PREVIEW_BOTTOM"), "screen after differential paint");
		expect(pty.screenText).not.toContain("OLD_TITLE");
		expect(pty.text).not.toContain("PREVIEW_BOTTOM");
	} finally { await pty.close(); }
});

test("PTY driver preserves split UTF-8 and closes a live child exactly once", async () => {
	const pty = new PtyDriver(["-e", 'const bytes = Buffer.from("中文_READY"); process.stdout.write(bytes.subarray(0, 1)); setImmediate(() => process.stdout.write(bytes.subarray(1))); setInterval(() => {}, 1000);']);
	try { await pty.waitFor(() => pty.text.includes("中文_READY"), "incremental UTF-8 output"); expect(pty.text).not.toContain("\ufffd"); }
	finally { const first = pty.close(); expect(pty.close()).toBe(first); await first; }
	expect(await pty.child.exited).toBeGreaterThan(0);
});

test("PTY driver reports early exit with its final output and observed input", async () => {
	const pty = new PtyDriver(["-e", 'console.log("EARLY_EXIT_SENTINEL"); process.exit(7);']);
	try {
		await bounded(pty.child.exited, "early child exit");
		await expect(pty.waitFor(() => false, "missing readiness")).rejects.toThrow("Child exited 7");
		await expect(pty.waitFor(() => false, "missing readiness")).rejects.toThrow("EARLY_EXIT_SENTINEL");
	} finally { await pty.close(); }
});

for (const failure of ["setup", "timeout"] as const) test(`Scenario settles the PTY and parent directory before reporting ${failure} failure`, async () => {
	let pty: PtyDriver | undefined, directory = "";
	await expect(withScenario(`pty-${failure}`, async scenario => {
		directory = scenario.directory;
		pty = new PtyDriver(["-e", "setInterval(() => {}, 1000)"], { cwd: scenario.cwd });
		scenario.defer(() => pty!.close());
		if (failure === "setup") throw new Error("Injected PTY setup failure");
		await scenario.gate("blocked body").wait();
	}, { timeoutMs: 20 })).rejects.toThrow(failure === "setup" ? "Injected PTY setup failure" : "Timed out: pty-timeout/scenario");
	expect(pty).toBeDefined();
	await bounded(pty!.child.exited, "failed Scenario child exit");
	expect(pty!.child.exitCode !== null || pty!.child.signalCode !== null).toBe(true);
	expect(existsSync(directory)).toBe(false);
});
