import { expect, test } from "bun:test";
import type { SessionMessage } from "../../packages/protocol/src/index.ts";

interface Report {
	type: string;
	text?: string;
	calls?: string[];
	raw?: boolean;
	pending?: number;
	messages?: SessionMessage[];
}

for (const mode of ["fifo", "stop", "replace", "failure"] as const) test(`PTY ADR010: ${mode} during slow SDK commit`, async () => {
	const reports: Report[] = [];
	let output = "";
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: mode === "stop" ? 40 : 80, rows: mode === "stop" ? 12 : 24, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/input-ownership.fixture.ts"], {
		terminal,
		env: { ...process.env, FORGE_AGENT_PTY_FAIL_COMMIT: mode === "failure" ? "1" : "0" },
		ipc(message) { reports.push(message as Report); },
	});
	async function waitFor(condition: () => boolean | Promise<boolean>) {
		for (let attempt = 0; attempt < 500; attempt++) {
			if (await condition()) return;
			if (child.exitCode !== null) throw new Error(`PTY exited: ${output.slice(-500)}`);
			await Bun.sleep(10);
		}
		throw new Error(`PTY timeout: ${JSON.stringify(reports)} ${output.slice(-500)}`);
	}
	async function frame() {
		const count = reports.length;
		child.send("frame");
		await waitFor(() => reports.slice(count).some((report) => report.type === "frame"));
		return reports.slice(count).find((report) => report.type === "frame")!;
	}
	try {
		await waitFor(() => reports.some((report) => report.type === "ready"));
		terminal.write("first\r");
		await waitFor(() => reports.some((report) => report.type === "saving"));
		terminal.write("second\rthird\r");
		await waitFor(async () => (await frame()).text?.includes("Queued 2: third") ?? false);
		const queued = await frame();
		expect(queued.calls).toEqual(["first"]);
		expect(queued.text).toContain("Queued 1: second");
		expect(queued.text).toContain("Queued 2: third");
		if (mode === "stop") {
			terminal.write("draft\x1b");
			await waitFor(async () => (await frame()).text?.includes("stopping") ?? false);
		} else if (mode === "replace" || mode === "failure") {
			terminal.write("chosen\x1b[13;5u");
			await waitFor(async () => (await frame()).text?.includes("Next: chosen") ?? false);
		}
		child.send("commit");
		const expected = mode === "fifo" ? ["first", "second", "third"] : mode === "replace" ? ["first", "chosen"] : ["first"];
		await waitFor(() => reports.some((report) => report.type === "settled" && report.calls?.length === expected.length));
		if (mode === "failure") await waitFor(async () => (await frame()).text?.includes("injected disk failure") ?? false);
		await Bun.sleep(30);
		const finalFrame = await frame();
		expect(finalFrame.calls).toEqual(expected);
		if (mode === "replace" || mode === "failure") {
			expect(finalFrame.text).toContain("second");
			expect(finalFrame.text).toContain("third");
		}
		if (mode === "stop") {
			expect(finalFrame.text).toContain("draft");
			terminal.write("\r");
			expected.push("second\n\nthird\n\ndraft");
			await waitFor(() => reports.some((report) => report.type === "settled" && report.calls?.length === 2));
		}
		if (mode === "failure") expect(finalFrame.text).toContain("chosen");
		terminal.write("\x03");
		await waitFor(() => child.exitCode !== null);
		expect(await child.exited).toBe(0);
		const result = reports.find((report) => report.type === "result")!;
		expect(result.raw).toBe(false);
		expect(result.pending).toBe(0);
		expect(result.messages?.filter((message) => message.role === "user").map((message) => message.content)).toEqual(
			(mode === "failure" ? [] : expected).map((text) => [{ type: "text", text }]),
		);
		expect(output).toContain("\x1b[?1049l");
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		terminal.close();
	}
}, 15_000);
