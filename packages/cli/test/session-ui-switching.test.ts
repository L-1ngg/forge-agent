import { App, frameToText } from "@forge-agent/tui";
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";
import { TestInput as Input } from "../../../tests/support/app-driver.ts";
import { waitFor as until } from "../../../tests/support/control.ts";
import { withScenario } from "../../../tests/support/scenario.ts";
import { SessionHost } from "../src/session-host.ts";
import { skillInput } from "../src/skills-command.ts";

test("TUI clear retains model context; new isolates it; resume restores history and draft without sending", async () => withScenario("TUI clear retains model context; new isolates it; resume restores history and draft without sending", async scenario => {
	const cwd = scenario.cwd;
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	await app.start();
	input.send("OLD_QUESTION\r");
	await until(() => requests.length === 1 && !screen().includes("working"), "() => requests.length === 1 && !screen().includes(\"working\")");
	input.send("/clear\r");
	expect(screen()).toContain("已清屏，上下文仍保留");
	expect(screen()).not.toContain("OLD_QUESTION");
	input.send("FOLLOW_UP\r");
	await until(() => requests.length === 2 && !screen().includes("working"), "() => requests.length === 2 && !screen().includes(\"working\")");
	expect(requests[1]).toContain("OLD_QUESTION");
	const original = sessions.current.id;
	input.send("\x1b[200~/new\nMY_DRAFT\x1b[201~\r");
	await until(() => sessions.current.id !== original, "() => sessions.current.id !== original");
	input.send("NEW_QUESTION\r");
	await until(() => requests.length === 3 && !screen().includes("working"), "() => requests.length === 3 && !screen().includes(\"working\")");
	expect(requests[2]).not.toContain("OLD_QUESTION");
	input.send("/resume\r");
	await until(() => screen().includes("选择会话"), "() => screen().includes(\"选择会话\")");
	input.send("\x1b[B\r");
	await until(() => sessions.current.id === original, "() => sessions.current.id === original");
	expect(screen()).toContain("MY_DRAFT");
	expect(screen()).toContain("OLD_QUESTION");
	expect(requests).toHaveLength(3);
}));

for (const failSave of [false, true]) test(`running resume waits for tool settlement and isolates pending input; save failure=${failSave}`, async () => withScenario(`running resume waits for tool settlement and isolates pending input; save failure=${failSave}`, async scenario => {
	const { mkdir, readFile, rename } = await import("node:fs/promises");
	const cwd = scenario.cwd;
	let calls = 0, started = false, aborted = false;
	let release!: () => void;
	const toolEnd = new Promise<void>(resolve => { release = resolve; });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
		calls++;
		return calls === 2 ? modelResponse([{ id: "waiting-tool", name: "wait", arguments: {} }]) : modelResponse();
	} });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test",
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "wait", label: "Wait", description: "wait", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute(_input, context) {
			started = true;
			context.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			await toolEnd;
			return { content: [{ type: "text", text: "TOOL_SETTLED" }], details: null };
		} }],
	});
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	try {
		await app.start();
		input.send("TARGET_SESSION\r");
		await until(() => calls === 1 && !screen().includes("working"), "() => calls === 1 && !screen().includes(\"working\")");
		const target = sessions.current.id;
		input.send("/new\r");
		await until(() => sessions.current.id !== target, "() => sessions.current.id !== target");
		input.send("ACTIVE_TASK\r");
		await until(() => started, "() => started");
		const active = sessions.current.id;
		input.send("QUEUED_INPUT\r/resume\r");
		await until(() => screen().includes("选择会话"), "() => screen().includes(\"选择会话\")");
		expect(aborted).toBe(false);
		input.send("\x1b");
		await until(() => !screen().includes("选择会话"), "() => !screen().includes(\"选择会话\")");
		expect(aborted).toBe(false);
		input.send("/resume\r");
		await until(() => screen().includes("选择会话"), "() => screen().includes(\"选择会话\")");
		input.send("\x1b[B\r");
		await until(() => aborted, "() => aborted");
		expect(sessions.current.id).toBe(active);
		expect(calls).toBe(2);
		if (failSave) { await rename(active, `${active}.saved`); await mkdir(active); }
		release();
		if (failSave) {
			await until(() => screen().includes("会话切换失败"), "() => screen().includes(\"会话切换失败\")");
			expect(sessions.current.id).toBe(active);
			expect(screen()).toContain("QUEUED_INPUT");
		} else {
			await until(() => sessions.current.id === target, "() => sessions.current.id === target");
			expect(await readFile(active, "utf8")).toContain("TOOL_SETTLED");
			expect(screen()).not.toContain("QUEUED_INPUT");
			input.send("/resume\r");
			await until(() => screen().includes("选择会话"), "() => screen().includes(\"选择会话\")");
			input.send("\r");
			await until(() => sessions.current.id === active, "() => sessions.current.id === active");
			expect(screen()).toContain("QUEUED_INPUT");
		}
		expect(calls).toBe(2);
	} finally { release(); }
}));

test("manual compaction persistence failure prevents new session activation", async () => withScenario("manual compaction persistence failure prevents new session activation", async scenario => {
	const { rename, mkdir } = await import("node:fs/promises");
	const cwd = scenario.cwd;
	let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return modelResponse([], "end_turn", calls <= 2 ? `work-${calls} `.repeat(1000) : JSON.stringify({ states: [], claims: [], taskChanged: false })); } });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test", context: { keepRecentTokens: 1 } });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	await app.start();
	input.send("COMPACT_ME\r");
	await until(() => calls === 1 && !screen().includes("working"), "() => calls === 1 && !screen().includes(\"working\")");
	input.send("RECENT_GOAL\r");
	await until(() => calls === 2 && !screen().includes("working"), "() => calls === 2 && !screen().includes(\"working\")");
	const active = sessions.current.id;
	await rename(active, `${active}.saved`); await mkdir(active);
	input.send("/compact\r");
	await until(() => calls > 2 && !screen().includes("compacting"), "() => calls > 2 && !screen().includes(\"compacting\")");
	input.send("/new\r");
	await until(() => screen().includes("会话切换失败"), "() => screen().includes(\"会话切换失败\")");
	expect(sessions.current.id).toBe(active);
}));

test("TUI unknown Skill input restores its original draft and keeps it with its session", async () => withScenario("TUI unknown Skill input restores its original draft and keeps it with its session", async scenario => {
	const cwd = scenario.cwd;
	await mkdir(join(cwd, "skills/manual"), { recursive: true });
	await writeFile(join(cwd, "skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual workflow\n---\nPRIVATE_SKILL_BODY");
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	scenario.defer(() => server.stop(true));
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", baseUrl: server.url.toString(), systemPrompt: "test", skills: { roots: { workspace: { path: "skills" } } } });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, prepareInput: skillInput, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 150, rows: 40, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	await app.start(); input.send("ORIGINAL_SESSION\r"); await until(() => requests.length === 1 && !screen().includes("working"), "() => requests.length === 1 && !screen().includes(\"working\")");
	const original = sessions.current.id;
	input.send("/skill missing ORIGINAL_TASK\r"); await until(() => screen().includes("unknown-skill") && !screen().includes("working"), "() => screen().includes(\"unknown-skill\") && !screen().includes(\"working\")");
	expect(screen()).toContain("/skill missing ORIGINAL_TASK");
	input.send("\x1b[H\x1b[200~/new\n\x1b[201~\r"); await until(() => sessions.current.id !== original, "() => sessions.current.id !== original");
	expect(requests).toHaveLength(1); expect(screen()).not.toContain("ORIGINAL_TASK");
	input.send("/resume\r"); await until(() => screen().includes("选择会话"), "() => screen().includes(\"选择会话\")"); input.send("\r");
	await until(() => sessions.current.id === original, "() => sessions.current.id === original");
	expect(screen()).toContain("/skill missing ORIGINAL_TASK"); expect(requests).toHaveLength(1);
}));

test("malformed Skill command returns the draft without faulting session switching", async () => withScenario("malformed Skill command returns the draft without faulting session switching", async scenario => {
	const cwd = scenario.cwd;
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, prepareInput: skillInput, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 120, rows: 32, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
	await app.start(); const original = sessions.current.id;
	input.send("/skill\r"); await until(() => screen().includes("Usage: /skill"), "() => screen().includes(\"Usage: /skill\")");
	expect(screen()).toContain("/skill");
	input.send("\x7f".repeat(6) + "/new\r");
	expect(screen()).toContain("正在切换会话");
	expect(screen()).not.toContain("Type a message");
	await until(() => sessions.current.id !== original && screen().includes("Type a message"), "() => sessions.current.id !== original && screen().includes(\"Type a message\")");
	expect(sessions.current.hasHistory()).toBe(false);
}));
