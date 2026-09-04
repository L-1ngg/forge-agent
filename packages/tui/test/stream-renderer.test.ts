import { expect, test } from "bun:test";
import { block, type SessionEvent } from "@myh/protocol";
import type { Terminal } from "@earendil-works/pi-tui";
import { App, StreamRenderer, createSemanticTheme, frameFromLines } from "../src/index.ts";
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

test("streaming text keeps one entry id through message_end", () => {
	const renderer = new StreamRenderer();
	renderer.apply({ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } });
	renderer.apply({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "partial" });
	const streamingIds = renderer.getEntryIds();
	expect(streamingIds).toEqual(["message-0-content-0"]);

	renderer.apply({ type: "message_end", timestamp: 3, message: { role: "assistant", content: [{ type: "text", text: "partial final" }], timestamp: 1 } });
	expect(renderer.getEntryIds()).toEqual(streamingIds);
	expect(renderer.render(80).join("\n")).toContain("partial final");
});

test("thinking placeholder keeps its shell id and manual fold across completion", () => {
	const renderer = new StreamRenderer();
	renderer.apply({ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } });
	renderer.apply({ type: "message_delta", timestamp: 2, contentIndex: 1, contentType: "thinking", delta: "reasoning" });
	const streamingIds = renderer.getEntryIds();
	expect(streamingIds).toEqual(["message-0-content-1"]);
	const foldId = renderer.latestFoldableBlockId();
	expect(foldId).toBe("thinking-0-1");
	expect(renderer.toggleBlock(foldId as string)).toBe(true);

	renderer.apply({ type: "message_end", timestamp: 3, message: { role: "assistant", content: [{ type: "text", text: "" }, { type: "thinking", thinking: "reasoning complete" }], timestamp: 1 } });
	expect(renderer.getEntryIds()).toEqual(streamingIds);
	expect(renderer.getBlockComponent(foldId as string)?.render(80)).toHaveLength(1);
});

test("tool placeholder keeps its entry id when the structured execution arrives", () => {
	const renderer = new StreamRenderer();
	const assistant = { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "call-stable", name: "bash", arguments: { command: "run" } }], timestamp: 1 };
	renderer.apply({ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } });
	renderer.apply({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "tool_call", delta: "{}" });
	const placeholderIds = renderer.getEntryIds();
	expect(placeholderIds).toEqual(["message-0-content-0"]);
	renderer.apply({ type: "message_end", timestamp: 3, message: assistant });
	renderer.apply({
		type: "tool_execution_end",
		timestamp: 4,
		toolCallId: "call-stable",
		toolName: "bash",
		content: "done",
		isError: false,
		block: block({ id: "call-stable", kind: "execute", lifecycle: "complete" }, { command: "run", stdout: "done" }, { defaultDisplayMode: "expanded" }),
	});
	expect(renderer.getEntryIds()).toEqual(placeholderIds);
});

test("renderer stays aligned with its projector through anomalous streaming and tool reconciliation", () => {
	const renderer = new StreamRenderer();
	const apply = (event: SessionEvent): void => {
		renderer.apply(event);
		expect(renderer.getEntryIds()).toEqual(renderer.getProjector().getEntryIds());
	};
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "thinking" as const, thinking: "reason" },
			{ type: "text" as const, text: "answer" },
			{ type: "tool_call" as const, id: "exec-integrated", name: "bash", arguments: { command: "run" } },
		],
		timestamp: 1,
	};
	const execute = block(
		{ id: "exec-integrated", kind: "execute", lifecycle: "streaming", currentDisplayMode: "expanded", manualOverride: false },
		{ command: "run", stdout: "working" },
		{ defaultDisplayMode: "expanded", respectManualFolds: true },
	);

	apply({ type: "message_delta", timestamp: 1, contentIndex: 1, contentType: "text", delta: "answer" });
	const deltaIds = renderer.getEntryIds();
	apply({ type: "message_start", timestamp: 2, message: { role: "assistant", content: [], timestamp: 1 } });
	expect(renderer.getEntryIds()).toEqual(deltaIds);
	expect(renderer.getProjector().getMessages()).toHaveLength(1);
	apply({ type: "tool_execution_start", timestamp: 3, toolCallId: execute.id, toolName: "bash", args: { command: "run" }, block: execute });
	expect(renderer.toggleBlock(execute.id)).toBe(true);
	apply({ type: "message_delta", timestamp: 4, contentIndex: 0, contentType: "thinking", delta: "reason" });
	apply({ type: "message_end", timestamp: 5, message: assistant });
	expect(renderer.getEntryIds()).toEqual(["message-0-content-0", "message-0-content-1", "message-0-content-2"]);
	expect(renderer.getProjector().getEntry("message-0-content-2")).toMatchObject({ kind: "execute", block: { id: execute.id, currentDisplayMode: "collapsed", manualOverride: true } });
	apply({ type: "message_end", timestamp: 5, message: assistant });
	expect(renderer.getProjector().getMessages()).toHaveLength(1);
	apply({ type: "message_start", timestamp: 5, message: assistant });
	apply({ type: "message_end", timestamp: 5, message: assistant });
	expect(renderer.getProjector().getMessages()).toHaveLength(1);

	const executeUpdate = block(
		{ id: execute.id, kind: "execute", lifecycle: "complete", currentDisplayMode: "expanded", manualOverride: false },
		{ command: "run", stdout: "finished" },
		{ defaultDisplayMode: "expanded", respectManualFolds: true },
	);
	apply({ type: "tool_execution_end", timestamp: 6, toolCallId: execute.id, toolName: "bash", content: "finished", isError: false, block: executeUpdate });
	expect(renderer.getRichBlocks().find((value) => value.id === execute.id)).toMatchObject({ currentDisplayMode: "collapsed", manualOverride: true });
	expect(renderer.toggleBlock(execute.id)).toBe(true);
	const executeResult = { role: "toolResult" as const, toolCallId: execute.id, toolName: "bash", content: [{ type: "text" as const, text: "finished" }], timestamp: 6 };
	apply({ type: "message_start", timestamp: 6, message: executeResult });
	apply({ type: "message_end", timestamp: 7, message: executeResult });
	expect(renderer.render(120).join("\n").match(/finished/g)?.length).toBe(1);

	const edit = block(
		{ id: "edit-integrated", kind: "edit", lifecycle: "complete", currentDisplayMode: "expanded" },
		{ path: "file.ts", hunks: [], additions: 1, removals: 0 },
		{ defaultDisplayMode: "expanded" },
	);
	apply({ type: "tool_execution_end", timestamp: 8, toolCallId: edit.id, toolName: "edit", content: "replacement summary", isError: false, block: edit });
	const editResult = { role: "toolResult" as const, toolCallId: edit.id, toolName: "edit", content: [{ type: "text" as const, text: "replacement summary" }], timestamp: 8 };
	apply({ type: "message_start", timestamp: 8, message: editResult });
	apply({ type: "message_end", timestamp: 9, message: editResult });
	expect(renderer.render(120).join("\n")).toContain("replacement summary");
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
	expect(rendered.indexOf("Run run")).toBeGreaterThan(rendered.indexOf("before"));
	expect(rendered.indexOf("between")).toBeGreaterThan(rendered.indexOf("Run run"));
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
	expect(rendered).toContain("Edit file.ts");
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
	expect(component?.render(80).join("\n")).toContain("… +3 lines");

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

test("execute rail and bullet cells follow lifecycle colors", () => {
	const lifecycleColors = {
		streaming: { kind: "rgb" as const, r: 1, g: 2, b: 3 },
		complete: { kind: "rgb" as const, r: 4, g: 5, b: 6 },
		failed: { kind: "rgb" as const, r: 7, g: 8, b: 9 },
	};
	const theme = createSemanticTheme({
		accent_running: (value) => `\u001b[38;2;1;2;3m${value}\u001b[39m`,
		accent_success: (value) => `\u001b[38;2;4;5;6m${value}\u001b[39m`,
		accent_error: (value) => `\u001b[38;2;7;8;9m${value}\u001b[39m`,
	});
	for (const lifecycle of ["streaming", "complete", "failed"] as const) {
		const renderer = new StreamRenderer({ theme });
		const rich = block(
			{ id: `exec-${lifecycle}`, kind: "execute", lifecycle },
			{ command: "run", stdout: "done", isError: lifecycle === "failed" },
			{ defaultDisplayMode: "expanded" },
		);
		if (lifecycle === "streaming") {
			renderer.apply({
				type: "tool_execution_start",
				timestamp: 1,
				toolCallId: rich.id,
				toolName: "bash",
				args: { command: "run" },
				block: rich,
			});
		} else {
			renderer.apply({
				type: "tool_execution_end",
				timestamp: 1,
				toolCallId: rich.id,
				toolName: "bash",
				content: "done",
				isError: lifecycle === "failed",
				block: rich,
			});
		}
		const frame = frameFromLines(renderer.render(30), 30);
		expect(frame.cells[0]?.[0]).toMatchObject({ grapheme: "┃", foreground: lifecycleColors[lifecycle] });
		expect(frame.cells[0]?.[3]).toMatchObject({ grapheme: "◆", foreground: lifecycleColors[lifecycle] });
	}
});

test("toggleBlock keeps shell rail chrome synchronized with the fold state", () => {
	const renderer = new StreamRenderer();
	const rich = block(
		{ id: "chrome-toggle", kind: "execute", lifecycle: "complete" },
		{ command: "run", stdout: "one\ntwo" },
		{ defaultDisplayMode: "expanded" },
	);
	renderer.apply({ type: "tool_execution_end", timestamp: 1, toolCallId: rich.id, toolName: "bash", content: "done", isError: false, block: rich });
	const expanded = frameFromLines(renderer.render(30), 30);
	expect(expanded.cells[0]?.[0]?.grapheme).toBe("┃");
	expect(expanded.cells[0]?.[3]?.grapheme).toBe("◆");

	expect(renderer.toggleBlock(rich.id)).toBe(true);
	expect(renderer.getRichBlocks().find((value) => value.id === rich.id)).toMatchObject({ currentDisplayMode: "collapsed", manualOverride: true });
	const collapsed = frameFromLines(renderer.render(30), 30);
	expect(collapsed.cells[0]?.[0]?.grapheme).toBe(" ");
	expect(collapsed.cells[0]?.[3]?.grapheme).toBe("◆");

	expect(renderer.toggleBlock(rich.id)).toBe(true);
	const reopened = frameFromLines(renderer.render(30), 30);
	expect(reopened.cells[0]?.[0]?.grapheme).toBe("┃");
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
