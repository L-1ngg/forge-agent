import { expect, test } from "bun:test";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { App, HeaderBar, createSemanticTheme, formatCompact } from "../src/index.ts";

const markerTheme = createSemanticTheme({
	muted: (value) => `\u001b[2m${value}\u001b[22m`,
	context: (value) => `\u001b[36m${value}\u001b[39m`,
});

test("header renders abbreviated cwd on the left and compact context on the right", () => {
	const header = new HeaderBar({
		cwd: "/home/u/dev/proj",
		homeDir: "/home/u",
		getUsage: () => ({ contextTokens: 13_000, contextWindow: 1_000_000 }),
		theme: markerTheme,
	});
	const line = stripTerminalSequences(header.render(60)[0] ?? "");
	expect(line.startsWith("~/dev/proj")).toBe(true);
	expect(line.trimEnd().endsWith("13K / 1.0M")).toBe(true);
});

test("header omits the right side when context usage is unknown", () => {
	const header = new HeaderBar({ cwd: "/repo", theme: markerTheme });
	const line = stripTerminalSequences(header.render(60)[0] ?? "");
	expect(line).toBe("/repo");
});

test("header stays hidden when there is nothing to show", () => {
	expect(new HeaderBar({ theme: markerTheme }).render(60)).toEqual([]);
});

test("formatCompact uses K/M suffixes", () => {
	expect(formatCompact(12)).toBe("12");
	expect(formatCompact(13_000)).toBe("13K");
	expect(formatCompact(1_000_000)).toBe("1.0M");
	expect(formatCompact(2_500_000)).toBe("2.5M");
});

test("working indicator appears while a turn runs and clears after it", async () => {
	const terminal = new FakeTerminal();
	let releaseTurn: (() => void) | undefined;
	const app = new App({
		terminal,
		port: {
			async *runTurn() {
				yield { type: "agent_start", timestamp: 1 };
				await new Promise<void>((resolve) => {
					releaseTurn = resolve;
				});
				yield { type: "agent_end", timestamp: 2 };
			},
			steer() {},
			followUp() {},
			abort() {
				releaseTurn?.();
			},
		},
	});
	await app.start();
	app.editor.setText("hi");
	app.editor.handleInput("\r");
	await Bun.sleep(0);
	expect(app.tui.render(80).join("\n")).toContain("Working…");
	releaseTurn?.();
	await Bun.sleep(0);
	await Bun.sleep(0);
	expect(app.tui.render(80).join("\n")).not.toContain("Working…");
	await app.stop();
});

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private input?: (data: string) => void;

	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
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
	send(data: string): void {
		this.input?.(data);
	}
}
