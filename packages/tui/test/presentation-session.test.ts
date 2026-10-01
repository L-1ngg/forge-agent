import { expect, test } from "bun:test";
import { request } from "@forge-agent/protocol";
import { App, frameToText, type AppSession, type AppSessionHost } from "../src/index.ts";
import { Host } from "../src/host.ts";
import { TestInput, TestOutput } from "../../../tests/support/app-driver.ts";
import { barrier, nextTurn, waitFor } from "../../../tests/support/control.ts";
import { createApp, FakeBus, fakePort } from "./helpers/app.ts";

test("startup failure restores the terminal and keeps stop idempotent", async () => {
	const input = new TestInput(), bus = new FakeBus(), chunks: string[] = [];
	let fail = true;
	const app = new App({ port: fakePort([]), requestBus: bus, host: "alt", cwd: "/tmp", homeDir: "/tmp", stdin: input, stdout: { columns: 80, rows: 24, write(text) { if (fail) { fail = false; throw new Error("terminal startup failed"); } chunks.push(text); } } });
	await expect(app.start()).rejects.toThrow("terminal startup failed");
	expect(input.raw).toBe(false);
	expect(app.stop()).toBe(app.stop()); await app.stop();
	expect(chunks.join("")).toContain("\x1b[?1049l");
});

test("repeated frames do not read Agent or bus, reconcile requests, send input or authorize", async () => {
	let usageReads = 0, terminalReads = 0, pendingReads = 0, turns = 0;
	const bus = new class extends FakeBus { isPending(): boolean { pendingReads++; return true; } }();
	const terminal = bus.getTerminal.bind(bus);
	bus.getTerminal = id => { terminalReads++; return terminal(id); };
	const observed = { ...fakePort([]), runTurn: () => { turns++; return fakePort([]).runTurn("unexpected"); }, getUsage: () => { usageReads++; return undefined; } };
	const { app, output } = createApp({ bus, port: observed });
	await app.start();
	try {
		bus.push(request("pure-frame", "question", { prompt: "Pure rendering" }));
		await waitFor(() => output.text.includes("Pure rendering"), "request painted");
		await nextTurn();
		usageReads = terminalReads = pendingReads = 0;
		const frame = frameToText(app.composeFrameForTest());
		for (let index = 0; index < 30; index++) expect(frameToText(app.composeFrameForTest())).toBe(frame);
		expect(usageReads).toBe(0); expect(terminalReads).toBe(0); expect(pendingReads).toBe(0);
		expect(turns).toBe(0); expect(bus.responses).toHaveLength(0);
	} finally { await app.stop(); }
});

test("container replacement preserves draft text and invalidates noncooperative copy feedback", async () => {
	const copy = barrier("old clipboard"), started = barrier("clipboard started");
	const original = Host.prototype.requestCopy;
	Host.prototype.requestCopy = async () => { started.release(); await copy.wait(); return "copied"; };
	const make = (id: string): AppSession => ({ id, requestBus: new FakeBus(), port: fakePort([]), hasHistory: () => true, history: [{ role: "assistant", content: [{ type: "text", text: `HISTORY_${id}` }], timestamp: 1 }] });
	const a = make("A"), b = make("B"); let current = a;
	const sessions: AppSessionHost = { get current() { return current; }, list: async () => ({ sessions: [{ id: "A", title: "RESTORE_A", updatedAt: 1 }], diagnostics: [] }), async switchTo(id, beforeRelease) { await beforeRelease?.(); current.requestBus.close(); current = id === "A" ? make("A") : b; return current; }, async dispose() { current.requestBus.close(); } };
	const input = new TestInput(), output = new TestOutput(110, 32);
	const app = new App({ port: a.port, requestBus: a.requestBus, sessions, host: "alt", cwd: "/tmp", homeDir: "/tmp", stdin: input, stdout: output });
	await app.start();
	try {
		input.send("\ty"); await started.wait(); input.send("\t\x1b[200~/new\nDRAFT_A\x1b[201~\r");
		await waitFor(() => current.id === "B", "B activated");
		copy.release(); await nextTurn();
		const frame = frameToText(app.composeFrameForTest());
		expect(frame).toContain("HISTORY_B"); expect(frame).not.toContain("HISTORY_A"); expect(frame).not.toContain("Copied");
		input.send("/resume\r"); await waitFor(() => frameToText(app.composeFrameForTest()).includes("RESTORE_A"), "restore menu"); input.send("\r");
		await waitFor(() => current.id === "A", "A restored");
		expect(frameToText(app.composeFrameForTest())).toContain("DRAFT_A");
		expect(frameToText(app.composeFrameForTest())).not.toContain("Copied");
	} finally { copy.release(); Host.prototype.requestCopy = original; await app.stop(); }
});
