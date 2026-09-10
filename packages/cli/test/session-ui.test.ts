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

test("resume preview is explicit, scrollable, and separate from restoring a session", async () => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const { readFile } = await import("node:fs/promises");
	const cwd = await mkdtemp(join(tmpdir(), "forge-preview-ui-"));
	const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", "one.jsonl"), cwd);
	for (const [i, text] of ["SAME_OPENING", "RECENT_WORK " + "line ".repeat(90), "LAST_MESSAGE"].entries()) await store.append(messageEntry({ role: i === 1 ? "assistant" : "user", content: [{ type: "text", text }], timestamp: i + 1 }, store.getLeafId()));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	let reads = 0;
	const originalPreview = sessions.preview.bind(sessions);
	const observed = { get current() { return sessions.current; }, list: () => sessions.list(), preview: async (...args: Parameters<typeof sessions.preview>) => { reads++; return originalPreview(...args); }, switchTo: sessions.switchTo.bind(sessions), dispose: sessions.dispose.bind(sessions) };
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions: observed, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 40, rows: 16, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		const before = await readFile(store.path, "utf8");
		const initial = sessions.current.id;
		await app.start(); input.send("/resume\r");
		await until(() => screen().includes("SAME_OPENING"));
		expect(reads).toBe(0);
		expect(screen()).not.toContain("RECENT_WORK");
		input.send("\x05");
		await until(() => screen().includes("RECENT_WORK"));
		expect(reads).toBe(1);
		expect(sessions.current.id).toBe(initial);
		input.send("\x1b[6~\x1b[6~\x1b[6~");
		await until(() => screen().includes("LAST_MESSAGE"));
		input.send("\x1b");
		await until(() => !screen().includes("RECENT_WORK") && !screen().includes("LAST_MESSAGE"));
		expect(screen()).toContain("选择会话");
		input.send("\x1b"); await until(() => !screen().includes("选择会话"));
		expect(sessions.current.id).toBe(initial);
		expect(await readFile(store.path, "utf8")).toBe(before);
		input.send("/resume\r"); await until(() => screen().includes("SAME_OPENING"));
		input.send("\r"); await until(() => sessions.current.id !== initial);
		expect(screen()).toContain("LAST_MESSAGE");
	} finally { await app.stop(); await sessions.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("loading and late preview results cannot reopen a dismissed picker or replace another candidate", async () => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const cwd = await mkdtemp(join(tmpdir(), "forge-preview-race-"));
	for (const [i, name] of ["FIRST", "SECOND"].entries()) {
		const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", `${name}.jsonl`), cwd);
		await store.append(messageEntry({ role: "user", content: [{ type: "text", text: name }], timestamp: i }, null));
		await store.append(messageEntry({ role: "assistant", content: [{ type: "text", text: `${name}_PREVIEW` }], timestamp: i }, store.getLeafId()));
	}
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	let releaseList!: () => void, releasePreview!: () => void;
	let holdList = true, holdPreview = true, previewStarted = false;
	const listGate = new Promise<void>(resolve => { releaseList = resolve; });
	const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
	const observed = {
		get current() { return sessions.current; },
		list: async () => { if (holdList) await listGate; return sessions.list(); },
		preview: async (...args: Parameters<typeof sessions.preview>) => { const result = await sessions.preview(...args); previewStarted = true; if (holdPreview) await previewGate; return result; },
		switchTo: sessions.switchTo.bind(sessions), dispose: sessions.dispose.bind(sessions),
	};
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions: observed, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 70, rows: 24, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start(); input.send("/resume\r");
		expect(screen()).toContain("正在读取会话");
		input.send("\x1b"); await until(() => !screen().includes("正在读取会话"));
		holdList = false; releaseList(); await Bun.sleep(30);
		expect(screen()).not.toContain("选择会话");
		input.send("/resume\r"); await until(() => screen().includes("SECOND"));
		input.send("\x05"); await until(() => previewStarted);
		input.send("\x1b[B");
		holdPreview = false; input.send("\x05");
		await until(() => screen().includes("FIRST_PREVIEW"));
		releasePreview(); await Bun.sleep(30);
		expect(screen()).not.toContain("SECOND_PREVIEW");
		input.send("\x1b"); await until(() => !screen().includes("FIRST_PREVIEW"));
		input.send("\x1b"); await until(() => !screen().includes("选择会话"));
		expect(sessions.current.hasHistory()).toBe(false);
	} finally { releaseList(); releasePreview(); await app.stop(); await sessions.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("preview cache is bounded to twenty excerpts and is released when the picker closes", async () => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const cwd = await mkdtemp(join(tmpdir(), "forge-preview-lru-"));
	for (let i = 0; i < 21; i++) {
		const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", `${i}.jsonl`), cwd);
		await store.append(messageEntry({ role: "user", content: [{ type: "text", text: `history-${i}` }], timestamp: i }, null));
	}
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	const cachedInputs: boolean[] = [];
	const observed = { get current() { return sessions.current; }, list: () => sessions.list(), preview: async (...args: Parameters<typeof sessions.preview>) => { cachedInputs.push(args[1] !== undefined); return sessions.preview(...args); }, switchTo: sessions.switchTo.bind(sessions), dispose: sessions.dispose.bind(sessions) };
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions: observed, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 70, rows: 24, write() {} } });
	const screen = () => frameToText(app.composeFrameForTest());
	const expand = async () => { input.send("\x05"); await until(() => screen().includes("用户：")); };
	try {
		await app.start(); input.send("/resume\r"); await until(() => screen().includes("history-20"));
		await expand(); input.send("\x05"); await expand();
		expect(cachedInputs).toEqual([false, true]);
		for (let i = 0; i < 20; i++) { input.send("\x1b[B"); await expand(); }
		input.send("\x1b[B"); await expand();
		expect(cachedInputs.at(-1)).toBe(false);
		input.send("\x05\x1b"); await until(() => !screen().includes("选择会话"));
		input.send("/resume\r"); await until(() => screen().includes("history-20")); await expand();
		expect(cachedInputs.at(-1)).toBe(false);
	} finally { await app.stop(); await sessions.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
