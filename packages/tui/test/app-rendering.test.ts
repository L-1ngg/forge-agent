import { type SessionMessage } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import { scriptedTurn } from "../../../tests/support/turn.ts";
import { App, frameToText, type AppPort } from "../src/index.ts";

import { TestInput as FakeInput, TestOutput as FakeOutput } from "../../../tests/support/app-driver.ts";
import { waitFor } from "../../../tests/support/control.ts";
import { createApp, FakeBus, fakePort } from "./helpers/app.ts";

test("coalesced output paints the final streamed frame and stops scheduled paints", async () => {
	const input = new FakeInput(), output = new FakeOutput(), bus = new FakeBus();
	const port: AppPort = { runTurn() { return scriptedTurn((async function* () {
		yield { type: "message_start", message: { role: "assistant", timestamp: 1, content: [] }, timestamp: 1 };
		for (let index = 0; index < 20; index++) yield { type: "message_delta", contentIndex: 0, contentType: "text", delta: "x", timestamp: 1 };
		yield { type: "message_end", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "FINAL_STREAM_SENTINEL" }] }, timestamp: 1 };
	})(), { status: "success" }); } };
	const app = new App({ port, requestBus: bus, host: "alt", cwd: "/tmp", homeDir: "/tmp", stdin: input, stdout: output });
	try {
		await app.start(); input.emit(Buffer.from("task\r"));
		await waitFor(() => output.text.includes("FINAL_STREAM_SENTINEL"), "() => output.text.includes(\"FINAL_STREAM_SENTINEL\")");
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(output.text).toContain("FINAL_STREAM_SENTINEL");
		expect(output.chunks.length).toBeLessThan(20);
		input.emit(Buffer.from("queued-paint")); await app.stop(); const writes = output.chunks.length;
		await new Promise<void>(resolve => setImmediate(resolve)); expect(output.chunks.length).toBe(writes);
	} finally { await app.stop(); }
});

test("main view places usage in the header, model on the prompt, and highlights only the selected dense row", async () => {
	const history: SessionMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Start the preview server" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Checking the project and preview response." },
			{ type: "tool_call", id: "a", name: "bash", arguments: { command: "pwd", description: "Inspect project" } },
			{ type: "tool_call", id: "b", name: "bash", arguments: { command: "curl localhost", description: "Check preview response" } }], timestamp: 2 },
	];
	const { app, input, output } = createApp({ history, port: { ...fakePort([]), getUsage: () => ({ contextTokens: 32000, contextWindow: 1000000 }) } });
	await app.start();
	try {
		input.emit(Buffer.from("\t"));
		for (const [columns, rows] of [[120, 32], [80, 24], [40, 12]]) {
			output.columns = columns!; output.rows = rows!;
			const frame = app.composeFrameForTest();
			const lines = frameToText(frame).split("\n");
			const selected = lines.findIndex((line) => line.includes("Check preview response"));
			const other = lines.findIndex((line) => line.includes("Inspect project"));
			expect(selected).toBeGreaterThan(other);
			expect(frame.cells[selected]![10]!.background).toEqual({ kind: "rgb", r: 28, g: 28, b: 28 });
			expect(frame.cells[other]![10]!.background).toEqual({ kind: "rgb", r: 20, g: 20, b: 20 });
			expect(lines[selected]).toContain("│");
			expect(lines.find((line) => line.includes("faux/faux-1"))).toMatch(/╰.*faux\/faux-1.*╯/);
			if (rows! >= 24) {
				expect(lines[1]).toContain("~/proj");
				expect(lines[1]).toContain("32K / 1.0M");
			}
		}
	} finally { await app.stop(); }
});

test("context display uses the port truth point instead of last response totals", async () => {
	const { app, input } = createApp({ port: {
		...fakePort([{ type: "message_end", timestamp: 1, message: {
			role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1,
			usage: { input: 9_000, output: 999, totalTokens: 9_999, cacheRead: 0, cacheWrite: 0 },
		} }]),
		getUsage: () => ({ contextTokens: 2_000, contextWindow: 128_000, contextEstimated: true }),
	} as AppPort });
	await app.start();
	try {
		input.emit(Buffer.from("go\r"));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("done"), "() => frameToText(app.composeFrameForTest()).includes(\"done\")");
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("~2K / 128K");
		expect(text).not.toContain("10K");
	} finally { await app.stop(); }
});
