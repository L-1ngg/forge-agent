import { expect, test } from "bun:test";
import { block } from "@myh/protocol";
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

test("Enter queues a draft through followUp while a turn is running", async () => {
	const terminal = new FakeTerminal();
	let releaseTurn: (() => void) | undefined;
	const calls: string[] = [];
	const followUps: string[] = [];
	const app = new App({
		terminal,
		port: {
			async *runTurn(input: string) {
				calls.push(input);
				yield { type: "agent_start", timestamp: calls.length };
				await new Promise<void>((resolve) => {
					releaseTurn = resolve;
				});
				yield { type: "agent_end", timestamp: calls.length + 10 };
			},
			steer() {},
			followUp(input: string) {
				followUps.push(input);
			},
			abort() {
				releaseTurn?.();
			},
		},
	});
	await app.start();
	app.editor.setText("first");
	app.editor.handleInput("\r");
	await Bun.sleep(0);
	app.editor.setText("queued");
	app.editor.handleInput("\r");
	await Bun.sleep(0);

	expect(calls).toEqual(["first"]);
	expect(followUps).toEqual(["queued"]);
	expect(app.editor.getText()).toBe("");
	releaseTurn?.();
	await Bun.sleep(0);
	await app.stop();
});

test("Ctrl+Enter aborts the old turn before consuming the new draft", async () => {
	const terminal = new FakeTerminal();
	const calls: string[] = [];
	let releaseTurn: (() => void) | undefined;
	let aborts = 0;
	const app = new App({
		terminal,
		port: {
			async *runTurn(input: string) {
				calls.push(input);
				yield { type: "agent_start", timestamp: calls.length };
				if (calls.length === 1) {
					await new Promise<void>((resolve) => {
						releaseTurn = resolve;
					});
				}
				yield { type: "agent_end", timestamp: calls.length + 10 };
			},
			steer() {},
			followUp() {},
			abort() {
				aborts++;
				releaseTurn?.();
			},
		},
	});
	await app.start();
	app.editor.setText("first");
	app.editor.handleInput("\r");
	await Bun.sleep(0);
	app.editor.setText("urgent");
	terminal.send("\u001b[13;5u");
	await Bun.sleep(0);
	await Bun.sleep(0);

	expect(aborts).toBe(1);
	expect(calls).toEqual(["first", "urgent"]);
	expect(app.editor.getText()).toBe("");
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

test("streamed block updates reuse the component and respect a manual fold", () => {
	const renderer = new StreamRenderer();
	const initial = block(
		{ id: "exec-1", kind: "execute", lifecycle: "streaming" },
		{ command: "run", stdout: "one\ntwo\nthree\nfour\nfive" },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3, respectManualFolds: true },
	);
	renderer.apply({ type: "tool_execution_start", timestamp: 1, toolCallId: "exec-1", toolName: "bash", args: { command: "run" }, block: initial });
	const component = renderer.getBlockComponent("exec-1");
	expect(component).toBeDefined();
	expect(renderer.toggleBlock("exec-1")).toBe(true);
	expect(component?.render(80)).toHaveLength(1);

	const update = block(
		{ id: "exec-1", kind: "execute", lifecycle: "complete" },
		{ command: "run", stdout: "one\ntwo\nthree\nfour\nfive\nsix" },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3, respectManualFolds: true },
	);
	renderer.apply({ type: "tool_execution_end", timestamp: 2, toolCallId: "exec-1", toolName: "bash", content: "done", isError: false, block: update });
	expect(renderer.getBlockComponent("exec-1")).toBe(component);
	expect(component?.render(80)).toHaveLength(1);
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
