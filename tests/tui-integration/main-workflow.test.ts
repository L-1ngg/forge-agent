import { expect, test } from "bun:test";
import { PtyDriver } from "../support/pty.ts";
import { withScenario } from "../support/scenario.ts";

test("PTY: startup to historical tool detail, search, copy, resize and return through the real SDK", async () => withScenario("PTY: startup to historical tool detail, search, copy, resize and return through the real SDK", async scenario => {

	let ready = false;
	let completed = 0;
	let raw: unknown;

	const pty = new PtyDriver(["tests/tui-integration/main-workflow.fixture.ts"], { columns: 120, rows: 32, env: { ...process.env, SHELL: "/bin/bash", FORGE_AGENT_PTY_DIRECTORY: scenario.cwd }, ipc(message) {
			if (message === "ready") ready = true;
			else if (message && typeof message === "object") {
				if ("completed" in message) completed++;
				if ("raw" in message) raw = message.raw;
			}
		} });
	scenario.defer(() => pty.close());
	const terminal = pty, child = pty.child;
	const waitFor = pty.waitFor.bind(pty);
	const capture = () => pty.frameText();
	const send = async (text: string) => { await pty.send(text); return capture(); };
	const resize = (columns: number, rows: number) => pty.resizeAndCapture(columns, rows);
	const reveal = async (needle: string) => {
		let text = await capture();
		for (let step = 0; !text.includes(needle) && step < 20; step++) text = await send("\x1b[5~");
		for (let step = 0; !text.includes(needle) && step < 20; step++) text = await send("\x1b[6~");
		expect(text).toContain(needle);
		return text;
	};
	await waitFor(() => ready);
	expect(await capture()).toMatch(/[▀▄█]/);
	expect(await send("/")).toContain("help");
	await send("\x1b"); await send("\x7f");
	await send("\x1b[200~Read files\n中文任务\x1b[201~");
	expect(await resize(40, 12)).toContain("forge-agent");
	expect(await resize(80, 24)).toContain("中文任务");
	await resize(120, 32);
	terminal.write("\r"); await waitFor(() => completed === 1);
	const summary = await capture();
	expect(summary).toContain("Read 10 files");
	expect(summary).toContain("1 failed");
	expect(pty.text).not.toContain("FILE_3_LINE_11");
	await send("draft retained");
	const summaryY = summary.split("\n").findIndex((line) => line.includes("Read 10 files")) + 1;
	await send(`\x1b[<0;8;${summaryY}M\x1b[<0;8;${summaryY}ml\t`);
	for (const [columns, rows] of [[40, 12], [80, 24], [120, 32]]) {
		await resize(columns!, rows!);
		const text = await reveal("Read sample-3.ts");
		const y = text.split("\n").findIndex((line) => line.includes("Read sample-3.ts")) + 1;
		const click = `\x1b[<0;8;${y}M\x1b[<0;8;${y}m`;
		expect(await send(click)).not.toContain("FILE_3_LINE_11");
		await send(click);
		// Default preview is head/tail; selecting via either input opens the same call.
		expect(await send("\r")).toContain("sample-3.ts");
		await send("/FILE_3_LINE_33\r");
		expect(await capture()).toContain("中文内容");
		await send("y");
		expect(pty.text).toContain(Buffer.from("FILE_3_LINE_33 中文内容").toString("base64"));
		await send("Vj"); await send("\x1b");
		expect(await capture()).toContain("sample-3.ts");
		await send("fFILE_3_LINE_33\r");
		expect(await capture()).toContain("中文内容");
		await send("f\x15\r");
		await send("w\x1b[6~\x1b[5~");
		await send("q");
		const returned = await send("h");
		expect(returned).toContain("Read sample-3.ts");
		expect(returned).toContain("draft retained");
		expect(completed).toBe(1);
		await send("\t");
	}
	await send("\r"); await waitFor(() => completed === 2);
	await resize(120, 32);
	await send("\tG");
	// Copy feedback expiry changes the viewport height while G follows the bottom.
	// Locate the edit only after it expires, so the click cannot use a stale row.
	await waitFor(async () => !(await capture()).includes("Copy requested"));
	let text = await reveal("Edit sample-0.ts");
	let y = text.split("\n").findIndex((line) => line.includes("Edit sample-0.ts")) + 1;
	await send(`\x1b[<0;8;${y}M\x1b[<0;8;${y}m\r`);
	expect(await capture()).toContain("+UPDATED_LINE_1");
	await send("qj"); // Execute is the next compact operation, without a synthetic group.
	await send("\r");
	expect(await capture()).toContain("EXECUTE_OUTPUT");
	await send("qj\r"); // The next row is the write call itself.
	expect(await capture()).toContain("GENERIC_TOOL_BODY");
	await send("q");
	text = await reveal("Read missing.ts");
	y = text.split("\n").findIndex((line) => line.includes("Read missing.ts")) + 1;
	await send(`\x1b[<0;8;${y}M\x1b[<0;8;${y}m\r`);
	expect(await capture()).toContain("failed");
	terminal.write("\x03");
	expect(await child.exited).toBe(0);
	expect(raw).toBe(false);
	expect(pty.text).toContain("\x1b[?1002h");
	expect(pty.text).toContain("\x1b[?1002l");
	expect(pty.text).toContain("\x1b[?1049l");
}, { timeoutMs: 26000 }), 35_000);
