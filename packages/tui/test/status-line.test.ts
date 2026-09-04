import { expect, test } from "bun:test";
import { App, MIN_DISPLAYED_COST_USD, StatusLine, createSemanticTheme, formatStatusLine } from "../src/index.ts";
import type { Terminal } from "@earendil-works/pi-tui";

test("status line uses current context values and omits unavailable metrics", () => {
	let current = { contextTokens: 80, contextWindow: 100, costUsd: 0.004, running: 1, model: "model-a" };
	const line = new StatusLine({ getState: () => current });
	expect(line.render(120).join("\n")).toContain("ctx 80/100 (80%)");
	expect(line.render(120).join("\n")).not.toContain("$0.004");
	current = { contextTokens: 20, contextWindow: 100, costUsd: MIN_DISPLAYED_COST_USD, running: 0, model: "model-b" };
	expect(line.render(120).join("\n")).toContain("ctx 20/100 (20%)");
	expect(line.render(120).join("\n")).toContain("$0.005");
	expect(line.render(120).join("\n")).toContain("model-b");
});

test("semantic theme slots are the only styling hooks used by the component", () => {
	const calls: string[] = [];
	const theme = createSemanticTheme({ context: (value) => { calls.push(value); return `<context>${value}</context>`; } });
	const line = new StatusLine({ state: { contextTokens: 4 }, theme });
	expect(line.render(80)[0]).toContain("<context>ctx 4</context>");
	expect(calls).toEqual(["ctx 4"]);
	expect(formatStatusLine({ contextTokens: 4, costUsd: 0.001 })).toBe("ctx 4");
});

test("idle zero counters do not create a status row", () => {
	const line = new StatusLine({ state: { running: 0, turn: 0 } });
	expect(line.render(80)).toEqual([]);
	expect(formatStatusLine({ running: 0, turn: 0 })).toBe("");
});

test("App header shows the port usage truth point while the status line omits context", async () => {
	const app = new App({
		terminal: new FakeTerminal(),
		port: {
			async *runTurn() {},
			steer() {},
			followUp() {},
			abort() {},
			getUsage: () => ({ contextTokens: 12, contextWindow: 100 }),
		},
		getStatus: () => ({ contextTokens: 88, contextWindow: 100, model: "stale-model" }),
	});
	expect(app.header.render(120).join("\n")).toContain("12 / 100");
	expect(app.statusLine.render(120).join("\n")).not.toContain("ctx");
	expect(app.statusLine.render(120).join("\n")).toContain("stale-model");
	await app.stop();
});

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}
