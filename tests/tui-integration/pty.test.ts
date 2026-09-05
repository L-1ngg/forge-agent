import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("PTY: paste, permission park, resize, execute and Ctrl+C restore the terminal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-agent-pty-"));
	await writeFile(join(directory, "file.txt"), "before");
	let output = "";
	let captures = 0;
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({ cols: 80, rows: 24, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } });
	const child = Bun.spawn(["bun", "tests/tui-integration/pty.fixture.ts"], {
		terminal, env: { ...process.env, FORGE_AGENT_PTY_DIRECTORY: directory },
		ipc(message) { if (message === "captured") captures++; },
	});
	const waitFor = async (condition: () => boolean | Promise<boolean>) => {
		for (let attempt = 0; attempt < 500; attempt++) {
			if (await condition()) return;
			if (child.exitCode !== null) throw new Error(`PTY child exited ${child.exitCode}: ${output.slice(-500)}`);
			await Bun.sleep(10);
		}
		throw new Error(`PTY condition timed out: ${output.slice(-500)}`);
	};
	try {
		await waitFor(() => output.includes("\x1b[?2004h") && output.includes("Type a message"));
		terminal.write("\x1b[200~edit\n你好");
		await Bun.sleep(50);
		terminal.write("\x1b[201");
		await Bun.sleep(50);
		terminal.write("~");
		await Bun.sleep(50);
		expect(output).not.toContain("Permission: edit");
		terminal.write("\r");
		await waitFor(() => output.includes("Permission: edit"));
		terminal.write("\x1b");
		await Bun.sleep(50);
		expect(await readFile(join(directory, "file.txt"), "utf8")).toBe("before");
		child.send("capture");
		await waitFor(() => captures === 1);
		terminal.resize(40, 12);
		child.kill("SIGWINCH");
		await Bun.sleep(50);
		child.send("capture");
		await waitFor(() => captures === 2);
		terminal.write("\t\r");
		await waitFor(async () => (await readFile(join(directory, "session.jsonl"), "utf8")).includes("EDIT_COMPLETE"));
		expect(await readFile(join(directory, "file.txt"), "utf8")).toBe("after");
		terminal.write("second\r");
		await Bun.sleep(150);
		terminal.write("\x03");
		await waitFor(() => child.exitCode !== null);
		expect(await child.exited).toBe(0);
		expect(output).toContain("\x1b[?2004l");
		expect(output).toContain("\x1b[?1049l");
		const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
		expect(result.raw).toBe(false);
		expect(result.pending).toBe(0);
		expect(result.frames.map((frame: { columns: number; rows: number }) => [frame.columns, frame.rows])).toEqual([[80, 24], [40, 12]]);
		const records = (await readFile(join(directory, "session.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(records.filter((record) => record.message?.role === "user").map((record) => record.message.content)).toEqual([[{ type: "text", text: "edit\n你好" }]]);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		terminal.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 15_000);
