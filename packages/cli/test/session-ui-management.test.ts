import { App, frameToText } from "@forge-agent/tui";
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";
import { TestInput as Input } from "../../../tests/support/app-driver.ts";
import { barrier, bounded, nextTurn, waitFor as until } from "../../../tests/support/control.ts";
import { withScenario } from "../../../tests/support/scenario.ts";
import { SessionHost } from "../src/session-host.ts";

test("late memory import after new cannot send to the selected session or alter its draft", async () => withScenario("late memory import after new cannot send to the selected session or alter its draft", async scenario => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const cwd = scenario.cwd;
	const source = SessionStore.create(join(cwd, ".forge-agent", "sessions", "source.jsonl"), cwd);
	await source.append(messageEntry({ role: "user", content: [{ type: "text", text: "SOURCE_MEMORY" }], timestamp: 1 }, null));
	const gate = barrier("release memory import");
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse(); } });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: server.url.toString(), systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	let command!: Promise<{ text: string; prompt: string }>;
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} }, memoryCommand: () => command = (async () => { await gate.wait(); return { text: "OLD_IMPORT_COMPLETE", prompt: await sessions.memoryImport(source.path) }; })() });
	scenario.defer(() => app.stop());
	try {
		await app.start(); const original = sessions.current.id;
		input.send("/memory import\r/new\r");
		await until(() => sessions.current.id !== original, "() => sessions.current.id !== original");
		input.send("TARGET_DRAFT");
		gate.release(); await command; await nextTurn();
		await bounded(sessions.current.port.waitForIdle(), "selected session idle");
		expect(requests).toBe(0);
		expect(sessions.current.hasHistory()).toBe(false);
		const frame = frameToText(app.composeFrameForTest());
		expect(frame).toContain("TARGET_DRAFT");
		expect(frame).not.toContain("OLD_IMPORT_COMPLETE");
	} finally { gate.release(); }
}));

for (const aliasPath of [false, true]) for (const failSwitch of [false, true]) test(`late memory import is invalidated when resume begins; path alias=${aliasPath}; assembly failure=${failSwitch}`, async () => withScenario(`late memory import is invalidated when resume begins; path alias=${aliasPath}; assembly failure=${failSwitch}`, async scenario => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const cwd = scenario.cwd;
	const target = SessionStore.create(join(cwd, ".forge-agent", "sessions", "target.jsonl"), cwd);
	await target.append(messageEntry({ role: "user", content: [{ type: "text", text: "TARGET_HISTORY" }], timestamp: 1 }, null));
	const release = barrier("late import"), started = barrier("import fetched");
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse(); } });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: server.url.toString(), systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const targetId = (await sessions.list()).sessions.find(session => session.title === "TARGET_HISTORY")?.id;
	if (!targetId) throw new Error("Target session was not discovered");
	for await (const _ of sessions.current.port.runTurn("SOURCE_HISTORY")) {}
	const input = new Input(); let command!: Promise<{ text: string; prompt: string }>;
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} },
		memoryCommand: () => command = (async () => { const prompt = await sessions.memoryImport(target.path); started.release(); await release.wait(); return { text: "LATE_RESUME_IMPORT", prompt }; })() });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start(); const original = sessions.current.id;
		input.send("/memory import\r"); await started.wait();
		input.send("/resume\r"); await until(() => screen().includes("选择会话") && screen().includes("TARGET_HISTORY"), "() => screen().includes(\"选择会话\") && screen().includes(\"TARGET_HISTORY\")");
		if (failSwitch) await writeFile(target.path, "{bad JSON}\n");
		input.send("\x1b[B\r");
		await until(() => failSwitch ? screen().includes("会话切换失败") : sessions.current.id === targetId, "() => failSwitch ? screen().includes(\"会话切换失败\") : sessions.current.id === targetId");
		input.send("CURRENT_DRAFT"); release.release(); await command; await nextTurn();
		expect(requests).toBe(1); expect(screen()).toContain("CURRENT_DRAFT"); expect(screen()).not.toContain("LATE_RESUME_IMPORT");
		expect(sessions.current.id).toBe(failSwitch ? original : targetId);
	} finally { release.release(); }
}, { pathAlias: aliasPath }));

test("current memory import reports its result and sends its prompt once", async () => withScenario("current memory import reports its result and sends its prompt once", async scenario => {
	const cwd = scenario.cwd;
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: server.url.toString(), systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} }, memoryCommand: async () => ({ text: "CURRENT_IMPORT_RESULT", prompt: "CURRENT_IMPORT_PROMPT" }) });
	scenario.defer(() => app.stop());
	await app.start(); input.send("/memory import\r");
	await until(() => requests.length === 1 && frameToText(app.composeFrameForTest()).includes("CURRENT_IMPORT_RESULT"), "() => requests.length === 1 && frameToText(app.composeFrameForTest()).includes(\"CURRENT_IMPORT_RESULT\")");
	await bounded(sessions.current.port.waitForIdle(), "import prompt");
	expect(requests).toHaveLength(1); expect(requests[0]).toContain("CURRENT_IMPORT_PROMPT"); expect(sessions.current.hasHistory()).toBe(true);
}));

for (const kind of ["memory", "skills", "mcp"] as const) test(`${kind} late error and finally cannot release a new management operation`, async () => withScenario(`${kind} late error and finally cannot release a new management operation`, async scenario => {
	const cwd = scenario.cwd;
	const gates = [barrier("old management"), barrier("new management")];
	const completed = [barrier("old settled"), barrier("new settled")];
	const signals: AbortSignal[] = [];
	let calls = 0;
	const work = async (report: (text: string) => void, signal?: AbortSignal) => {
		const index = calls++;
		if (signal) signals.push(signal);
		try { await gates[index]!.wait(); if (index === 0) { report("OLD_REPORT"); throw new Error("OLD_ERROR"); } report("CURRENT_RESULT"); return { text: "CURRENT_RESULT" }; }
		finally { completed[index]!.release(); }
	};
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} },
		...(kind === "memory" ? { memoryCommand: (_input: string, signal?: AbortSignal) => work(() => {}, signal) } : kind === "skills" ? { skillsCommand: async (_input: string, report: (text: string) => void, signal?: AbortSignal) => { await work(report, signal); } } : { mcpCommand: async (_input: string, report: (text: string) => void, signal?: AbortSignal) => { await work(report, signal); } }) });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start(); const original = sessions.current.id;
		input.send(`/${kind}\r`); await until(() => calls === 1, "() => calls === 1");
		input.send("/new\r"); await until(() => sessions.current.id !== original, "() => sessions.current.id !== original");
		expect(signals[0]?.aborted).toBe(true);
		input.send(`/${kind}\r`); await until(() => calls === 2, "() => calls === 2");
		gates[0]!.release(); await completed[0]!.wait(); await nextTurn();
		input.send(`/${kind}\r`);
		expect(calls).toBe(2);
		expect(screen()).toContain("still running"); expect(screen()).not.toContain("OLD_ERROR"); expect(screen()).not.toContain("OLD_REPORT");
		gates[1]!.release(); await until(() => screen().includes("CURRENT_RESULT"), "() => screen().includes(\"CURRENT_RESULT\")");
	} finally { for (const gate of gates) gate.release(); }
}));

test("stop invalidates memory import without waiting for its callback or painting a late result", async () => withScenario("stop invalidates memory import without waiting for its callback or painting a late result", async scenario => {
	const cwd = scenario.cwd;
	const gate = barrier("stopped import"), started = barrier("import started");
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input(); let paints = 0;
	let command!: Promise<{ text: string; prompt: string }>;
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() { paints++; } }, memoryCommand: () => command = (async () => { started.release(); await gate.wait(); return { text: "LATE_STOP_RESULT", prompt: "LATE_STOP_PROMPT" }; })() });
	scenario.defer(() => app.stop());
	try {
		await app.start(); input.send("/memory import\r"); await started.wait();
		await bounded(app.stop(), "stop with pending management", 500);
		const stoppedPaints = paints;
		gate.release(); await command; await nextTurn();
		expect(paints).toBe(stoppedPaints);
		expect(frameToText(app.composeFrameForTest())).not.toContain("LATE_STOP");
		expect(sessions.current.hasHistory()).toBe(false);
	} finally { gate.release(); }
}));
