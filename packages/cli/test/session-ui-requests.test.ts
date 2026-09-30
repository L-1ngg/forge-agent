import { App, frameToText } from "@forge-agent/tui";
import { expect, test } from "bun:test";
import { TestInput as Input } from "../../../tests/support/app-driver.ts";
import { barrier, waitFor as until } from "../../../tests/support/control.ts";
import { withScenario } from "../../../tests/support/scenario.ts";
import { SessionHost } from "../src/session-host.ts";

test("TUI retires a card after its terminal was evicted while notification consumption was paused", async () => withScenario("TUI retires a card after its terminal was evicted while notification consumption was paused", async scenario => {
	const cwd = scenario.cwd;
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const bus = sessions.current.requestBus, release = barrier("slow terminal subscriber"), input = new Input();
	let responded = 0;
	const app = new App({ port: sessions.current.port, requestBus: { requests: () => bus.requests(), async *terminals() { await release.wait(); yield* bus.terminals(); }, isPending: id => bus.isPending(id), getTerminal: id => bus.getTerminal(id), respond(value) { responded++; return bus.respond(value); }, close: () => bus.close() }, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write() {} } });
	scenario.defer(() => app.stop());
	try {
		await app.start();
		const id = bus.publish("permission", { toolCall: { type: "tool_call", id: "tool", name: "bash", arguments: { command: "CARD_SENTINEL" } } }, () => {});
		await until(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: bash\")");
		bus.cancel(id);
		for (let index = 0; index < 300; index++) { const next = bus.publish("question", { prompt: `ended-${index}` }, () => {}); bus.cancel(next); }
		expect(bus.getTerminal(id)).toBeUndefined();
		expect(frameToText(app.composeFrameForTest())).not.toContain("Permission: bash");
		input.send("\r"); expect(responded).toBe(0); expect(bus.pendingCount).toBe(0);
	} finally { release.release(); }
}));

test("a settled real request paints its retirement without another input or frame query", async () => withScenario("a settled real request paints its retirement without another input or frame query", async scenario => {
	const cwd = scenario.cwd;
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const chunks: string[] = [], input = new Input(), bus = sessions.current.requestBus;
	const app = new App({ port: sessions.current.port, requestBus: bus, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 110, rows: 32, write(text) { chunks.push(text); } } });
	scenario.defer(() => app.stop());
	await app.start();
	const id = bus.publish("permission", { toolCall: { type: "tool_call", id: "tool", name: "bash", arguments: { command: "RETIRE_SENTINEL" } } }, () => {});
	await until(() => chunks.join("").includes("Yes, proceed") && chunks.join("").includes("No, reject"), "() => chunks.join(\"\").includes(\"Yes, proceed\") && chunks.join(\"\").includes(\"No, reject\")");
	const painted = chunks.length;
	expect(bus.cancel(id)).toBe(true);
	await until(() => chunks.slice(painted).join("").includes("cancelled"), "() => chunks.slice(painted).join(\"\").includes(\"cancelled\")");
	expect(chunks.slice(painted).join("")).not.toContain("Yes, proceed");
	const frame = frameToText(app.composeFrameForTest());
	expect(frame).toContain("cancelled"); expect(frame).not.toContain("No, reject");
}));

test("empty-session draft requires explicit discard; cancel preserves it without persistence", async () => withScenario("empty-session draft requires explicit discard; cancel preserves it without persistence", async scenario => {
	const cwd = scenario.cwd;
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	scenario.defer(() => sessions.dispose());
	const input = new Input();
	const app = new App({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: { columns: 100, rows: 24, write() {} } });
	scenario.defer(() => app.stop());
	const screen = () => frameToText(app.composeFrameForTest());
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
	await until(() => sessions.current.id !== original, "() => sessions.current.id !== original");
	expect(screen()).not.toContain("UNSENT");
	expect((await sessions.list()).sessions).toEqual([]);
}));
