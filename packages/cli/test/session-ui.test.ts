import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, frameToText } from "@forge-agent/tui";
import { SessionHost } from "../src/session-host.ts";
import { modelResponse } from "../../core/test/helpers/model-response.ts";

class Input {
	private listeners = new Set<(chunk: Buffer) => void>();
	setRawMode() {} resume() {} pause() {}
	on(_event: "data", listener: (chunk: Buffer) => void) { this.listeners.add(listener); }
	off(_event: "data", listener: (chunk: Buffer) => void) { this.listeners.delete(listener); }
	send(text: string) { for (const listener of this.listeners) listener(Buffer.from(text)); }
}
async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 3000;
	while (!(await check())) { if (Date.now() > deadline) throw new Error("UI condition timed out"); await Bun.sleep(5); }
}

test("TUI clear retains model context; new isolates it; resume restores history and draft without sending", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-session-ui-"));
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test" });
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start();
		input.send("OLD_QUESTION\r");
		await until(() => requests.length === 1 && !screen().includes("working"));
		input.send("/clear\r");
		expect(screen()).toContain("已清屏，上下文仍保留");
		expect(screen()).not.toContain("OLD_QUESTION");
		input.send("FOLLOW_UP\r");
		await until(() => requests.length === 2 && !screen().includes("working"));
		expect(requests[1]).toContain("OLD_QUESTION");
		const original = sessions.current.id;
		input.send("\x1b[200~/new\nMY_DRAFT\x1b[201~\r");
		await until(() => sessions.current.id !== original);
		input.send("NEW_QUESTION\r");
		await until(() => requests.length === 3 && !screen().includes("working"));
		expect(requests[2]).not.toContain("OLD_QUESTION");
		input.send("/resume\r");
		await until(() => screen().includes("选择会话"));
		input.send("\x1b[B\r");
		await until(() => sessions.current.id === original);
		expect(screen()).toContain("MY_DRAFT");
		expect(screen()).toContain("OLD_QUESTION");
		expect(requests).toHaveLength(3);
	} finally { await app.stop(); await sessions.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

for (const failSave of [false, true]) test(`running resume waits for tool settlement and isolates pending input; save failure=${failSave}`, async () => {
	const { mkdir, readFile, rename } = await import("node:fs/promises");
	const cwd = await mkdtemp(join(tmpdir(), "forge-switch-"));
	let calls = 0, started = false, aborted = false;
	let release!: () => void;
	const toolEnd = new Promise<void>(resolve => { release = resolve; });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
		calls++;
		return calls === 2 ? modelResponse([{ id: "waiting-tool", name: "wait", arguments: {} }]) : modelResponse();
	} });
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test",
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "wait", label: "Wait", description: "wait", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute(_input, context) {
			started = true;
			context.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			await toolEnd;
			return { content: [{ type: "text", text: "TOOL_SETTLED" }], details: null };
		} }],
	});
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start();
		input.send("TARGET_SESSION\r");
		await until(() => calls === 1 && !screen().includes("working"));
		const target = sessions.current.id;
		input.send("/new\r");
		await until(() => sessions.current.id !== target);
		input.send("ACTIVE_TASK\r");
		await until(() => started);
		const active = sessions.current.id;
		input.send("QUEUED_INPUT\r/resume\r");
		await until(() => screen().includes("选择会话"));
		expect(aborted).toBe(false);
		input.send("\x1b");
		await until(() => !screen().includes("选择会话"));
		expect(aborted).toBe(false);
		input.send("/resume\r");
		await until(() => screen().includes("选择会话"));
		input.send("\x1b[B\r");
		await until(() => aborted);
		expect(sessions.current.id).toBe(active);
		expect(calls).toBe(2);
		if (failSave) { await rename(active, `${active}.saved`); await mkdir(active); }
		release();
		if (failSave) {
			await until(() => screen().includes("会话切换失败"));
			expect(sessions.current.id).toBe(active);
			expect(screen()).toContain("QUEUED_INPUT");
		} else {
			await until(() => sessions.current.id === target);
			expect(await readFile(active, "utf8")).toContain("TOOL_SETTLED");
			expect(screen()).not.toContain("QUEUED_INPUT");
			input.send("/resume\r");
			await until(() => screen().includes("选择会话"));
			input.send("\r");
			await until(() => sessions.current.id === active);
			expect(screen()).toContain("QUEUED_INPUT");
		}
		expect(calls).toBe(2);
	} finally { release(); await app.stop(); await sessions.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

test("empty-session draft requires explicit discard; cancel preserves it without persistence", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-empty-draft-"));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 100, rows: 24, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start();
		const original = sessions.current.id;
		input.send("\x1b[200~/new\nUNSENT\x1b[201~\r");
		expect(screen()).toContain("丢弃后切换");
		input.send("n");
		expect(screen()).toContain("UNSENT");
		expect(sessions.current.id).toBe(original);
		// Insert the command as a new first line while keeping the unsent body.
		input.send("\x1b[H\x1b[200~/new\n\x1b[201~\r");
		expect(screen()).toContain("丢弃后切换");
		input.send("y");
		await until(() => sessions.current.id !== original);
		expect(screen()).not.toContain("UNSENT");
		expect((await sessions.list()).sessions).toEqual([]);
	} finally { await app.stop(); await sessions.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("manual compaction persistence failure prevents new session activation", async () => {
	const { rename, mkdir } = await import("node:fs/promises");
	const cwd = await mkdtemp(join(tmpdir(), "forge-compact-switch-"));
	let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return modelResponse(); } });
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test", context: { keepRecentTokens: 1 } });
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start();
		input.send("COMPACT_ME\r");
		await until(() => calls === 1 && !screen().includes("working"));
		const active = sessions.current.id;
		await rename(active, `${active}.saved`); await mkdir(active);
		input.send("/compact\r");
		await until(() => calls > 1 && !screen().includes("compacting"));
		input.send("/new\r");
		await until(() => screen().includes("会话切换失败"));
		expect(sessions.current.id).toBe(active);
	} finally { await app.stop(); await sessions.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});
