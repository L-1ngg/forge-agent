import { App, frameToText } from "@forge-agent/tui";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { TestInput as Input } from "../../../tests/support/app-driver.ts";
import { nextTurn, waitFor as until } from "../../../tests/support/control.ts";
import { withScenario } from "../../../tests/support/scenario.ts";
import { SessionHost } from "../src/session-host.ts";

test("resume preview is explicit, scrollable, and separate from restoring a session", async () => withScenario("resume preview is explicit, scrollable, and separate from restoring a session", async scenario => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const { readFile } = await import("node:fs/promises");
	const cwd = scenario.cwd;
	const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", "one.jsonl"), cwd);
	for (const [i, text] of ["SAME_OPENING", "RECENT_WORK " + "line ".repeat(90), "LAST_MESSAGE"].entries()) await store.append(messageEntry({ role: i === 1 ? "assistant" : "user", content: [{ type: "text", text }], timestamp: i + 1 }, store.getLeafId()));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	let reads = 0;
	const originalPreview = sessions.preview.bind(sessions);
	const observed = { get current() { return sessions.current; }, list: () => sessions.list(), preview: async (...args: Parameters<typeof sessions.preview>) => { reads++; return originalPreview(...args); }, switchTo: sessions.switchTo.bind(sessions), dispose: sessions.dispose.bind(sessions) };
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions: observed, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 40, rows: 16, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	const before = await readFile(store.path, "utf8");
	const initial = sessions.current.id;
	await app.start(); input.send("/resume\r");
	await until(() => screen().includes("SAME_OPENING"), "() => screen().includes(\"SAME_OPENING\")");
	expect(reads).toBe(0);
	expect(screen()).not.toContain("RECENT_WORK");
	input.send("\x05");
	await until(() => screen().includes("RECENT_WORK"), "() => screen().includes(\"RECENT_WORK\")");
	expect(reads).toBe(1);
	expect(sessions.current.id).toBe(initial);
	input.send("\x1b[6~\x1b[6~\x1b[6~");
	await until(() => screen().includes("LAST_MESSAGE"), "() => screen().includes(\"LAST_MESSAGE\")");
	input.send("\x1b");
	await until(() => !screen().includes("RECENT_WORK") && !screen().includes("LAST_MESSAGE"), "() => !screen().includes(\"RECENT_WORK\") && !screen().includes(\"LAST_MESSAGE\")");
	expect(screen()).toContain("选择会话");
	input.send("\x1b"); await until(() => !screen().includes("选择会话"), "() => !screen().includes(\"选择会话\")");
	expect(sessions.current.id).toBe(initial);
	expect(await readFile(store.path, "utf8")).toBe(before);
	input.send("/resume\r"); await until(() => screen().includes("SAME_OPENING"), "() => screen().includes(\"SAME_OPENING\")");
	input.send("\r"); await until(() => sessions.current.id !== initial, "() => sessions.current.id !== initial");
	expect(screen()).toContain("LAST_MESSAGE");
}));

test("loading and late preview results cannot reopen a dismissed picker or replace another candidate", async () => withScenario("loading and late preview results cannot reopen a dismissed picker or replace another candidate", async scenario => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const cwd = scenario.cwd;
	for (const [i, name] of ["FIRST", "SECOND"].entries()) {
		const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", `${name}.jsonl`), cwd);
		await store.append(messageEntry({ role: "user", content: [{ type: "text", text: name }], timestamp: i }, null));
		await store.append(messageEntry({ role: "assistant", content: [{ type: "text", text: `${name}_PREVIEW` }], timestamp: i }, store.getLeafId()));
	}
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	let releaseList!: () => void, releasePreview!: () => void;
	let holdList = true, holdPreview = true, previewStarted = false, listFinished = false, stalePreviewFinished = false;
	const listGate = new Promise<void>(resolve => { releaseList = resolve; });
	const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
	const observed = {
		get current() { return sessions.current; },
		list: async () => { if (holdList) await listGate; const result = await sessions.list(); listFinished = true; return result; },
		preview: async (...args: Parameters<typeof sessions.preview>) => { const result = await sessions.preview(...args); previewStarted = true; if (holdPreview) { await previewGate; stalePreviewFinished = true; } return result; },
		switchTo: sessions.switchTo.bind(sessions), dispose: sessions.dispose.bind(sessions),
	};
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions: observed, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 70, rows: 24, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start(); input.send("/resume\r");
		expect(screen()).toContain("正在读取会话");
		input.send("\x1b"); await until(() => !screen().includes("正在读取会话"), "() => !screen().includes(\"正在读取会话\")");
		holdList = false; releaseList(); await until(() => listFinished, "dismissed listing completes"); await nextTurn();
		expect(screen()).not.toContain("选择会话");
		input.send("/resume\r"); await until(() => screen().includes("SECOND"), "() => screen().includes(\"SECOND\")");
		input.send("\x05"); await until(() => previewStarted, "() => previewStarted");
		input.send("\x1b[B");
		holdPreview = false; input.send("\x05");
		await until(() => screen().includes("FIRST_PREVIEW"), "() => screen().includes(\"FIRST_PREVIEW\")");
		releasePreview(); await until(() => stalePreviewFinished, "stale preview completes"); await nextTurn();
		expect(screen()).not.toContain("SECOND_PREVIEW");
		input.send("\x1b"); await until(() => !screen().includes("FIRST_PREVIEW"), "() => !screen().includes(\"FIRST_PREVIEW\")");
		input.send("\x1b"); await until(() => !screen().includes("选择会话"), "() => !screen().includes(\"选择会话\")");
		expect(sessions.current.hasHistory()).toBe(false);
	} finally { releaseList(); releasePreview(); }
}));

test("preview cache is bounded to twenty excerpts and is released when the picker closes", async () => withScenario("preview cache is bounded to twenty excerpts and is released when the picker closes", async scenario => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const cwd = scenario.cwd;
	for (let i = 0; i < 21; i++) {
		const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", `${i}.jsonl`), cwd);
		await store.append(messageEntry({ role: "user", content: [{ type: "text", text: `history-${i}` }], timestamp: i }, null));
	}
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const cachedInputs: boolean[] = [];
	const observed = { get current() { return sessions.current; }, list: () => sessions.list(), preview: async (...args: Parameters<typeof sessions.preview>) => { cachedInputs.push(args[1] !== undefined); return sessions.preview(...args); }, switchTo: sessions.switchTo.bind(sessions), dispose: sessions.dispose.bind(sessions) };
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions: observed, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 70, rows: 24, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	const expand = async () => { input.send("\x05"); await until(() => screen().includes("用户："), "() => screen().includes(\"用户：\")"); };
	await app.start(); input.send("/resume\r"); await until(() => screen().includes("history-20"), "() => screen().includes(\"history-20\")");
	await expand(); input.send("\x05"); await expand();
	expect(cachedInputs).toEqual([false, true]);
	for (let i = 0; i < 20; i++) { input.send("\x1b[B"); await expand(); }
	input.send("\x1b[B"); await expand();
	expect(cachedInputs.at(-1)).toBe(false);
	input.send("\x05\x1b"); await until(() => !screen().includes("选择会话"), "() => !screen().includes(\"选择会话\")");
	input.send("/resume\r"); await until(() => screen().includes("history-20"), "() => screen().includes(\"history-20\")"); await expand();
	expect(cachedInputs.at(-1)).toBe(false);
}));
