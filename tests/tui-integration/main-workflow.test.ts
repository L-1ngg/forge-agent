import { expect, test } from "bun:test";
import type { FrameDump } from "../../packages/tui/src/frame.ts";

test("PTY: startup to historical tool detail, search, copy, resize and return through the real SDK", async () => {
	let output = "";
	let ready = false;
	let completed = 0;
	let raw: unknown;
	const frames: FrameDump[] = [];
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 120, rows: 32, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/main-workflow.fixture.ts"], {
		terminal, env: { ...process.env, SHELL: "/bin/bash" },
		ipc(message) {
			if (message === "ready") ready = true;
			else if (message && typeof message === "object") {
				if ("frame" in message) frames.push(message.frame as FrameDump);
				if ("completed" in message) completed++;
				if ("raw" in message) raw = message.raw;
			}
		},
	});
	const waitFor = async (condition: () => boolean) => {
		for (let attempt = 0; attempt < 600; attempt++) {
			if (condition()) return;
			if (child.exitCode !== null) throw new Error(`PTY exited ${child.exitCode}: ${output.slice(-1000)}`);
			await Bun.sleep(10);
		}
		throw new Error(`PTY timeout: ${output.slice(-1000)}`);
	};
	const capture = async () => {
		const count = frames.length;
		child.send("capture"); await waitFor(() => frames.length > count);
		return frames.at(-1)!.cells.map((row) => row.map((cell) => cell.grapheme).join("").trimEnd()).join("\n");
	};
	const send = async (text: string) => { terminal.write(text); await Bun.sleep(45); return capture(); };
	const resize = async (columns: number, rows: number) => { terminal.resize(columns, rows); child.kill("SIGWINCH"); await Bun.sleep(50); return capture(); };
	const reveal = async (needle: string) => {
		let text = await capture();
		for (let step = 0; !text.includes(needle) && step < 20; step++) text = await send("\x1b[5~");
		for (let step = 0; !text.includes(needle) && step < 20; step++) text = await send("\x1b[6~");
		expect(text).toContain(needle);
		return text;
	};
	try {
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
		expect(output).not.toContain("FILE_3_LINE_11");
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
			expect(output).toContain(Buffer.from("FILE_3_LINE_33 中文内容").toString("base64"));
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
		expect(output).toContain("\x1b[?1002h");
		expect(output).toContain("\x1b[?1002l");
		expect(output).toContain("\x1b[?1049l");
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited; terminal.close();
	}
}, 30_000);
