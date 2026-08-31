import { expect, test } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { App, StreamRenderer } from "../src/index.ts";

test("groups streamed deltas by contentIndex even when they arrive out of order", () => {
	const renderer = new StreamRenderer();
	renderer.apply({ type: "message_delta", timestamp: 1, contentIndex: 2, contentType: "tool_call", delta: "}" });
	renderer.apply({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "hello" });
	renderer.apply({ type: "message_delta", timestamp: 3, contentIndex: 2, contentType: "tool_call", delta: "{" });
	renderer.apply({ type: "message_delta", timestamp: 4, contentIndex: 1, contentType: "thinking", delta: "reason" });
	expect(renderer.getOrderedBlocks()).toEqual([
		{ kind: "text", text: "hello" },
		{ kind: "thinking", text: "reason" },
		{ kind: "tool_call", text: "}{" },
	]);
});

test("Esc aborts a streaming turn without clearing the draft", async () => {
	const terminal = new FakeTerminal();
	let releaseTurn: (() => void) | undefined;
	let aborted = false;
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
				aborted = true;
				releaseTurn?.();
			},
		},
	});
	await app.start();
	app.editor.setText("start");
	app.editor.handleInput("\r");
	await Bun.sleep(0);
	app.editor.setText("keep this draft");
	terminal.send("\u001b");
	await Bun.sleep(0);
	expect(aborted).toBe(true);
	expect(app.editor.getText()).toBe("keep this draft");
	await app.stop();
});

test("Ctrl+C stops an idle app", async () => {
	const terminal = new FakeTerminal();
	const app = new App({
		terminal,
		port: {
			async *runTurn() {},
			steer() {},
			followUp() {},
			abort() {},
		},
	});
	await app.start();
	terminal.send("\u0003");
	await app.waitUntilStopped();
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
