import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameDump } from "../../packages/tui/src/frame.ts";

test("PTY: real read calls collapse, expand individually, scroll and survive resize", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-agent-tool-ui-"));
	await writeFile(join(directory, "short.txt"), "skip\nSHORT_BODY_2\nSHORT_BODY_3");
	await writeFile(join(directory, "long.txt"), Array.from({ length: 60 }, (_, i) => `LONG_BODY_${i + 1}`).join("\n"));
	let output = "";
	let ready = false;
	let done = false;
	let raw: unknown;
	const frames: FrameDump[] = [];
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 80, rows: 24, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/tool-ui.fixture.ts"], {
		terminal, env: { ...process.env, FORGE_AGENT_PTY_DIRECTORY: directory },
		ipc(message) {
			if (message === "ready") ready = true;
			else if (message === "turn-done") done = true;
			else if (message && typeof message === "object") {
				if ("frame" in message) frames.push(message.frame as FrameDump);
				if ("raw" in message) raw = message.raw;
			}
		},
	});
	const waitFor = async (condition: () => boolean) => {
		for (let attempt = 0; attempt < 500; attempt++) {
			if (condition()) return;
			if (child.exitCode !== null) throw new Error(`PTY exited ${child.exitCode}`);
			await Bun.sleep(10);
		}
		throw new Error(`Tool UI PTY condition timed out: ${output.slice(-1500)}`);
	};
	const capture = async () => {
		const count = frames.length;
		child.send("capture");
		await waitFor(() => frames.length > count);
		return frames.at(-1)!.cells.map((row) => row.map((cell) => cell.grapheme).join("").trimEnd()).join("\n");
	};
	const input = async (text: string) => { terminal.write(text); await Bun.sleep(50); return capture(); };
	try {
		await waitFor(() => ready);
		terminal.write("read files\r");
		await waitFor(() => done);
		const summary = await capture();
		expect(summary).toContain("Read 2 files");
		const summaryY = summary.split("\n").findIndex((line) => line.includes("Read 2 files")) + 1;
		const collapsed = await input(`\x1b[<0;8;${summaryY}M\x1b[<0;8;${summaryY}ml`);
		expect(collapsed).toContain("Read short.txt (2-3)");
		expect(collapsed).toContain("Read long.txt");
		expect(collapsed).not.toContain("SHORT_BODY");
		expect(collapsed).not.toContain("LONG_BODY");
		// No intermediate streamed frame may leak a result before an explicit expansion.
		expect(output).not.toContain("SHORT_BODY");
		expect(output).not.toContain("LONG_BODY");
		const shortY = collapsed.split("\n").findIndex((line) => line.includes("Read short.txt")) + 1;
		expect(await input(`\x1b[<0;5;${shortY}M\x1b[<0;5;${shortY}m`)).not.toContain("SHORT_BODY");
		const expanded = await input(`\x1b[<0;5;${shortY}M\x1b[<0;5;${shortY}m`);
		expect(expanded).toContain("2  SHORT_BODY_2");
		expect(expanded).toContain("3  SHORT_BODY_3");
		expect(expanded).not.toContain("LONG_BODY");
		expect(expanded).not.toContain('"totalLines"');
		await input("hjl");
		expect(await capture()).toContain("LONG_BODY_1");
		let bottom = await input("G");
		expect(bottom).toContain("LONG_BODY_60");
		for (const [columns, rows] of [[80, 24], [40, 12]]) {
			terminal.resize(columns!, rows!);
			child.kill("SIGWINCH");
			await Bun.sleep(50);
			bottom = await input("G");
			const up = await input("\x1b[<64;10;5M");
			expect(up.match(/LONG_BODY_\d+/)?.[0]).not.toBe(bottom.match(/LONG_BODY_\d+/)?.[0]);
			expect(await input("\x1b[<65;10;5M")).toBe(bottom);
			expect(up).not.toContain("64;10;");
		}
		const folded = await input("h");
		expect(folded).not.toContain("LONG_BODY");
		terminal.resize(80, 24);
		child.kill("SIGWINCH");
		await Bun.sleep(50);
		const restored = await capture();
		const longY = restored.split("\n").findIndex((line) => line.includes("Read long.txt")) + 1;
		expect(longY).toBeGreaterThan(0);
		await input(`\x1b[<0;5;${longY}M\x1b[<0;5;${longY}m`);
		const clickedLong = await input(`\x1b[<0;5;${longY}M\x1b[<0;5;${longY}m`);
		expect(clickedLong.split("\n")[longY - 1], clickedLong).toContain("Read long.txt");
		expect(clickedLong).toContain("LONG_BODY_1");
		expect(await input("h")).not.toContain("LONG_BODY");
		terminal.write("\x03");
		expect(await child.exited).toBe(0);
		expect(raw).toBe(false);
		expect(output).toContain("\x1b[?1000h\x1b[?1006h");
		expect(output).toContain("\x1b[?1006l\x1b[?1000l");
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		terminal.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 15_000);
