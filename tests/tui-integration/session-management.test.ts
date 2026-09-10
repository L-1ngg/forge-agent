import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelResponse } from "../../packages/core/test/helpers/model-response.ts";

test("real CLI PTY: empty exit, clear, new, resume, active cancellation and restart", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-session-pty-"));
	const requests: string[] = [];
	let hold = false;
	let release: (() => void) | undefined;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.text());
		if (hold) await new Promise<void>(resolve => { release = resolve; request.signal.addEventListener("abort", resolve, { once: true }); });
		return modelResponse();
	} });
	await mkdir(join(cwd, ".forge-agent"));
	await writeFile(join(cwd, ".forge-agent", "config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "test-local", baseUrl: server.url.toString(), thinkingLevel: "off" }));
	const files = async () => (await readdir(join(cwd, ".forge-agent", "sessions")).catch(() => [])).filter(name => name.endsWith(".jsonl"));
	const saved = async (text: string) => {
		for (const name of await files()) if ((await readFile(join(cwd, ".forge-agent", "sessions", name), "utf8")).includes(text)) return true;
		return false;
	};
	const children: Array<{ child: Bun.Subprocess; terminal: Bun.Terminal }> = [];
	const launch = () => {
		let output = "";
		const decoder = new TextDecoder();
		const terminal = new Bun.Terminal({ cols: 110, rows: 32, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } });
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../packages/cli/src/main.ts")], { cwd, terminal, env: { ...process.env, XDG_CONFIG_HOME: join(cwd, "config-home"), FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "", FORGE_AGENT_API_KEY: "" } });
		children.push({ child, terminal });
		const wait = async (condition: () => boolean | Promise<boolean>) => {
			for (let i = 0; i < 500; i++) { if (await condition()) return; if (child.exitCode !== null) throw new Error(`CLI exited: ${output.slice(-1000)}`); await Bun.sleep(10); }
			throw new Error(`PTY timeout: ${output.slice(-1000)}`);
		};
		const send = (command: string) => { output = ""; terminal.write(`\x1b[200~${command}\x1b[201~\r`); };
		return { child, terminal, wait, send, clear: () => { output = ""; }, output: () => output };
	};
	try {
		const empty = launch();
		await empty.wait(() => empty.output().includes("Type a message"));
		empty.terminal.write("\x03");
		expect(await empty.child.exited).toBe(0);
		expect(await files()).toEqual([]);
		const live = launch();
		await live.wait(() => live.output().includes("Type a message"));
		live.send("PTY_OLD");
		await live.wait(() => saved("saved answer"));
		live.send("/clear");
		await live.wait(() => live.output().includes("已清屏，上下文仍保留"));
		live.send("PTY_FOLLOWUP");
		await live.wait(() => requests.length === 2 && live.output().includes("saved answer"));
		expect(requests[1]).toContain("PTY_OLD");
		live.send("/new");
		await live.wait(() => live.output().includes("Type a message"));
		live.send("PTY_NEW");
		await live.wait(async () => (await files()).length === 2 && live.output().includes("saved answer"));
		expect(requests[2]).not.toContain("PTY_OLD");
		live.send("/resume");
		await live.wait(() => live.output().includes("选择会话"));
		live.terminal.write("\x05");
		await live.wait(() => live.output().includes("最近对话"));
		expect(requests).toHaveLength(3);
		live.terminal.write("\x1b"); await Bun.sleep(60);
		live.terminal.write("\x1b[B\r");
		await live.wait(() => live.output().includes("PTY_FOLLOWUP"));
		hold = true;
		live.send("PTY_RUNNING");
		await live.wait(() => requests.length === 4);
		live.send("/resume");
		await live.wait(() => live.output().includes("选择会话"));
		live.terminal.write("\x05");
		await live.wait(() => live.output().includes("最近对话"));
		live.terminal.write("\x1b"); await Bun.sleep(60);
		live.terminal.write("\x1b");
		await Bun.sleep(80);
		expect(requests).toHaveLength(4);
		live.send("/new");
		release?.(); hold = false;
		await live.wait(() => live.output().includes("Type a message"));
		live.terminal.write("\x03");
		expect(await live.child.exited).toBe(0);
		expect(await files()).toHaveLength(2);
		// Add synthetic long recent text so narrow-terminal scrolling has observable endpoints.
		const { SessionStore, messageEntry } = await import("../../packages/core/src/index.ts");
		for (const name of await files()) {
			const path = join(cwd, ".forge-agent", "sessions", name);
			if (!(await readFile(path, "utf8")).includes("PTY_RUNNING")) continue;
			const store = await SessionStore.open(path, cwd);
			await store.append(messageEntry({ role: "user", content: [{ type: "text", text: "PREVIEW_TOP\n" + Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") + "\nPREVIEW_BOTTOM" }], timestamp: Date.now() }, store.getLeafId()));
		}
		const reopened = launch();
		await reopened.wait(() => reopened.output().includes("Type a message"));
		expect(reopened.output()).not.toContain("PTY_OLD");
		reopened.terminal.resize(40, 16);
		reopened.clear();
		// Enter and Escape are decoded in one input batch: Escape runs while list() awaits I/O.
		reopened.terminal.write("\x1b[200~/resume\x1b[201~\r\x1b\x00\x1b[200~LOADING_EXIT_DRAFT\x1b[201~");
		await reopened.wait(() => reopened.output().includes("LOADING_EXIT_DRAFT"));
		await Bun.sleep(80);
		expect(reopened.output()).not.toContain("选择会话");
		reopened.terminal.write("\x7f".repeat("LOADING_EXIT_DRAFT".length));
		reopened.send("/resume");
		await reopened.wait(() => reopened.output().includes("PTY_OLD"));
		reopened.terminal.write("\x05");
		await reopened.wait(() => reopened.output().includes("最近对话"));
		await reopened.wait(() => reopened.output().includes("saved answer"));
		expect(reopened.output()).not.toContain("PREVIEW_BOTTOM");
		reopened.clear(); reopened.terminal.write("\x1b[6~".repeat(10));
		await reopened.wait(() => reopened.output().includes("PREVIEW_BOTTOM"));
		reopened.clear(); reopened.terminal.write("\x1b[5~".repeat(10));
		await reopened.wait(() => reopened.output().includes("saved answer"));
		expect(reopened.output()).not.toContain("PREVIEW_BOTTOM");
		expect(requests).toHaveLength(4);
		reopened.clear(); reopened.terminal.write("\r");
		await reopened.wait(() => reopened.output().includes("PREVIEW_BOTTOM"));
		reopened.terminal.write("\x03");
		expect(await reopened.child.exited).toBe(0);
		expect(await files()).toHaveLength(2);
	} finally {
		release?.(); server.stop(true);
		for (const { child, terminal } of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; terminal.close(); }
		await rm(cwd, { recursive: true, force: true });
	}
}, 20_000);
