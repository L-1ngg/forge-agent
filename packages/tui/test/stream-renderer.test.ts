import { expect, test } from "bun:test";
import { block } from "@myh/protocol";
import type { Terminal } from "@earendil-works/pi-tui";
import { App, StreamRenderer } from "../src/index.ts";
import { FoldBlock } from "../src/blocks/fold.ts";

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

test("renders tool calls once, suppresses projected tool results, and keeps stream order", () => {
	const renderer = new StreamRenderer();
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text: "before" },
			{ type: "tool_call" as const, id: "call-1", name: "bash", arguments: { command: "run" } },
			{ type: "text" as const, text: "between" },
		],
		timestamp: 1,
	};
	const blockData = block(
		{ id: "call-1", kind: "execute", lifecycle: "complete" },
		{ command: "run", stdout: "done" },
		{ defaultDisplayMode: "expanded" },
	);

	renderer.apply({ type: "message_start", timestamp: 1, message: assistant });
	renderer.apply({ type: "message_end", timestamp: 2, message: assistant });
	renderer.apply({ type: "tool_execution_end", timestamp: 3, toolCallId: "call-1", toolName: "bash", content: "done", isError: false, block: blockData });
	const toolResult = {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text" as const, text: "done" }],
		isError: false,
		timestamp: 3,
	};
	renderer.apply({ type: "message_start", timestamp: 3, message: toolResult });
	renderer.apply({ type: "message_end", timestamp: 4, message: toolResult });
	renderer.apply({
		type: "message_start",
		timestamp: 5,
		message: { role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 5 },
	});

	const rendered = renderer.render(120).join("\n");
	expect(rendered.indexOf("before")).toBeGreaterThanOrEqual(0);
	expect(rendered.indexOf("v execute $ run")).toBeGreaterThan(rendered.indexOf("before"));
	expect(rendered.indexOf("between")).toBeGreaterThan(rendered.indexOf("v execute $ run"));
	expect(rendered.indexOf("after")).toBeGreaterThan(rendered.indexOf("between"));
	expect(rendered).not.toContain('bash({"command":"run"})');
	expect(rendered.match(/done/g)?.length).toBe(1);
});

test("keeps an unprojected tool result visible as a fallback", () => {
	const renderer = new StreamRenderer();
	const toolResult = {
		role: "toolResult" as const,
		toolCallId: "unprojected",
		toolName: "bash",
		content: [{ type: "text" as const, text: "fallback result" }],
		isError: false,
		timestamp: 1,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message: toolResult });
	renderer.apply({ type: "message_end", timestamp: 2, message: toolResult });
	expect(renderer.render(120).join("\n")).toContain("fallback result");
});

test("keeps an edit result summary alongside its diff projection", () => {
	const renderer = new StreamRenderer();
	const editArguments = { path: "file.ts" };
	const assistant = {
		role: "assistant" as const,
		content: [{ type: "tool_call" as const, id: "edit-call", name: "edit", arguments: editArguments }],
		timestamp: 1,
	};
	const editBlock = block(
		{ id: "edit-call", kind: "edit", lifecycle: "streaming" },
		{ path: "file.ts", hunks: [], additions: 1, removals: 0 },
		{ defaultDisplayMode: "expanded" },
	);
	const result = {
		role: "toolResult" as const,
		toolCallId: "edit-call",
		toolName: "edit",
		content: [{ type: "text" as const, text: "replacements: 1" }],
		isError: false,
		timestamp: 2,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message: assistant });
	renderer.apply({ type: "message_end", timestamp: 1, message: assistant });
	renderer.apply({ type: "tool_execution_start", timestamp: 2, toolCallId: "edit-call", toolName: "edit", args: editArguments, block: editBlock });
	renderer.apply({ type: "message_start", timestamp: 2, message: result });
	renderer.apply({ type: "message_end", timestamp: 3, message: result });

	const rendered = renderer.render(120).join("\n");
	expect(rendered).toContain("edit file.ts");
	expect(rendered).toContain("replacements: 1");
});

test("keeps a fallback preview for executed tool calls that have no structured block", () => {
	const renderer = new StreamRenderer();
	const message = {
		role: "assistant" as const,
		content: [{ type: "tool_call" as const, id: "read-call", name: "read", arguments: { path: "README.md" } }],
		timestamp: 1,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });
	renderer.apply({ type: "tool_execution_start", timestamp: 3, toolCallId: "read-call", toolName: "read", args: { path: "README.md" } });
	expect(renderer.render(120).join("\n")).toContain('read({"path":"README.md"})');
});

test("suppresses the raw-args marker for calls that never executed", () => {
	const renderer = new StreamRenderer();
	const message = {
		role: "assistant" as const,
		content: [{ type: "tool_call" as const, id: "denied-call", name: "bash", arguments: { command: "rm -rf tmp" } }],
		timestamp: 1,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });
	expect(renderer.render(120).join("\n")).not.toContain("rm -rf tmp");
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

test("streamed block updates apply new fold metadata without reopening a manual fold", () => {
	const renderer = new StreamRenderer();
	const initial = block(
		{ id: "metadata-1", kind: "execute", lifecycle: "streaming", defaultDisplayMode: "expanded", currentDisplayMode: "expanded", manualOverride: false },
		{ command: "run", stdout: "one\ntwo\nthree" },
		{ defaultDisplayMode: "expanded", respectManualFolds: true },
	);
	renderer.apply({ type: "tool_execution_start", timestamp: 1, toolCallId: "metadata-1", toolName: "bash", args: { command: "run" }, block: initial });
	const component = renderer.getBlockComponent("metadata-1");
	expect(component).toBeInstanceOf(FoldBlock);
	if (!(component instanceof FoldBlock)) throw new Error("expected a fold block component");

	const update = block(
		{ id: "metadata-1", kind: "execute", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false },
		{ command: "run", stdout: "one\ntwo\nthree\nfour\nfive" },
		{ defaultDisplayMode: "truncated", firstLines: 1, lastLines: 1, respectManualFolds: true },
	);
	renderer.apply({ type: "tool_execution_end", timestamp: 2, toolCallId: "metadata-1", toolName: "bash", content: "done", isError: false, block: update });
	expect(renderer.getBlockComponent("metadata-1")).toBe(component);
	expect(component?.render(80).join("\n")).toContain("lines omitted");

	renderer.toggleBlock("metadata-1");
	const folded = renderer.getRichBlocks().find((value) => value.id === "metadata-1");
	expect(folded).toMatchObject({ currentDisplayMode: "collapsed", manualOverride: true });

	const streamed = block(
		{ id: "metadata-1", kind: "execute", lifecycle: "streaming", defaultDisplayMode: "expanded", currentDisplayMode: "expanded", manualOverride: false },
		{ command: "run", stdout: "new\ncontent" },
		{ defaultDisplayMode: "expanded", respectManualFolds: true },
	);
	renderer.apply({ type: "tool_execution_update", timestamp: 3, toolCallId: "metadata-1", toolName: "bash", content: "partial", block: streamed });
	expect(component?.render(80)).toHaveLength(1);
	expect(renderer.getRichBlocks().find((value) => value.id === "metadata-1")).toMatchObject({ currentDisplayMode: "collapsed", manualOverride: true });

	const releaseManual = block(
		{ id: "metadata-1", kind: "execute", lifecycle: "streaming", defaultDisplayMode: "expanded", currentDisplayMode: "expanded", manualOverride: false },
		{ command: "run", stdout: "released" },
		{ defaultDisplayMode: "expanded", respectManualFolds: false },
	);
	renderer.apply({ type: "tool_execution_update", timestamp: 4, toolCallId: "metadata-1", toolName: "bash", content: "released", block: releaseManual });
	expect(component?.displayMode).toBe("expanded");
	expect(renderer.getRichBlocks().find((value) => value.id === "metadata-1")).toMatchObject({ currentDisplayMode: "expanded", manualOverride: false });
});

test("Ctrl+O toggles the latest structured block through the App input route", async () => {
	const terminal = new FakeTerminal();
	const app = new App({ terminal, port: {
		async *runTurn() {},
		steer() {},
		followUp() {},
		abort() {},
	} });
	const data = block(
		{ id: "toggle-route", kind: "execute", lifecycle: "complete" },
		{ command: "run", stdout: "one\ntwo" },
		{ defaultDisplayMode: "expanded" },
	);
	app.renderer.apply({ type: "tool_execution_end", timestamp: 1, toolCallId: "toggle-route", toolName: "bash", content: "done", isError: false, block: data });
	await app.start();
	expect(app.renderer.getBlockComponent("toggle-route")).toBeDefined();
	terminal.send("\u000f");
	expect(app.renderer.getRichBlocks().find((value) => value.id === "toggle-route")).toMatchObject({ manualOverride: true, currentDisplayMode: "collapsed" });
	await app.stop();
});

test("PageUp routes to the application transcript scroll in the regular host", async () => {
	const terminal = new FakeTerminal();
	const app = new App({ terminal, port: {
		async *runTurn() {},
		steer() {},
		followUp() {},
		abort() {},
	} });
	let moved = 0;
	const originalScroll = app.transcript.scrollLines.bind(app.transcript);
	(app.transcript as unknown as { scrollLines: (lines: number) => void }).scrollLines = (lines) => {
		moved += lines;
		originalScroll(lines);
	};
	await app.start();
	terminal.send("\u001b[5~");
	expect(moved).toBeLessThan(0);
	await app.stop();
});

test("regular host renders only the transcript viewport and moves it on page navigation", async () => {
	const terminal = new FakeTerminal();
	terminal.rows = 8;
	const app = new App({ terminal, port: {
		async *runTurn() {},
		steer() {},
		followUp() {},
		abort() {},
	} });
	for (let index = 0; index < 20; index++) {
		app.renderer.apply({
			type: "message_start",
			timestamp: index,
			message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }], timestamp: index },
		});
	}

	const bottom = app.tui.render(80).join("\n");
	const bottomOffset = app.transcript.offset;
	app.transcript.scrollLines(-2);
	const earlier = app.tui.render(80).join("\n");

	// Layout-agnostic: entries may occupy more than one line (spacing, cards).
	const lineNumbers = (rendered: string) => [...rendered.matchAll(/line (\d+)/g)].map((match) => Number(match[1]));
	expect(bottomOffset).toBeGreaterThan(0);
	expect(bottom).toContain("line 19");
	expect(Math.max(...lineNumbers(earlier))).toBeLessThan(Math.max(...lineNumbers(bottom)));
	expect(earlier).not.toContain("line 19");
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
