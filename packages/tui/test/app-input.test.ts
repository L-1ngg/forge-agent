import { block, type SessionEvent } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import { scriptedTurn } from "../../../tests/support/turn.ts";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../src/ansi.ts";
import { frameToText, type AppCompletionSource, type AppPort } from "../src/index.ts";

import { nextTurn, waitFor } from "../../../tests/support/control.ts";
import { createApp, fakePort } from "./helpers/app.ts";

test.each(["success", "deferred", "length", "error", "aborted"] as const)("queued input waits for settlement and follows final %s", async status => {
	const calls: string[] = [];
	let settle!: (result: { status: typeof status }) => void;
	let streamEnded = false;
	const result = new Promise<{ status: typeof status }>(resolve => { settle = resolve; });
	const { app, input } = createApp({ port: {
		runTurn(value) {
			if (typeof value !== "string") throw new Error("This fixture accepts text inputs");
			calls.push(value);
			return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
				yield { type: "message_start", message: { role: "user", content: [{ type: "text", text: value }], timestamp: 0 }, timestamp: 0 };
				yield { type: "agent_end", outcome: "error", timestamp: 1 };
				streamEnded = true;
			})(), calls.length === 1 ? result : { status: "success" });
		},
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => streamEnded, "() => streamEnded");
		input.emit(Buffer.from("second\r"));
		expect(calls).toEqual(["first"]);
		settle({ status });
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		expect(calls).toEqual(status === "error" || status === "aborted" ? ["first"] : ["first", "second"]);
		if (status === "error" || status === "aborted") expect(frameToText(app.composeFrameForTest())).toContain("❯ second");
	} finally { settle({ status }); await app.stop(); }
});

test("selected historical tool previews and opens details without submitting the draft", async () => {
	const events: SessionEvent[] = ["older", "newer"].flatMap((id) => [
		{ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts`, offset: 10 }, timestamp: 1 },
		{ type: "tool_execution_end", toolCallId: id, toolName: "read", content: JSON.stringify({ content: Array.from({ length: 16 }, (_, i) => `${id}_${i + 10}`).join("\n") }), isError: false, timestamp: 2 },
	]);
	const { app, input, bus } = createApp({ port: fakePort(events) });
	const send = (text: string) => input.emit(Buffer.from(text));
	const view = () => frameToText(app.composeFrameForTest());
	await app.start();
	try {
		send("go\r");
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		send("draft\t");
		// Open the summary, then choose its first historical member.
		send("lje");
		expect(view()).toContain("older_10");
		expect(view()).toContain("older_25");
		expect(view()).not.toContain("older_18");
		expect(view()).not.toContain("newer_10");
		send("e\r");
		expect(view()).toContain("older.ts");
		expect(view()).toContain("older_18");
		send("/older_22\r");
		expect(view()).toContain("older_22");
		send("q\t");
		expect(view()).toContain("draft");
		expect(view()).not.toContain("older_18");
		expect(bus.responses).toHaveLength(0);
	} finally { await app.stop(); }
});

test("startup uses a centered live composer, adapts to a narrow viewport, then enters the conversation", async () => {
	const { app, input, output } = createApp({ showWelcome: true });
	await app.start();
	try {
		let frame = app.composeFrameForTest();
		expect(frameToText(frame)).not.toContain("Type a message to start");
		expect(frameToText(frame)).toMatch(/[▀▄█]/);
		expect(frame.cursor!.y).toBeLessThan(18);
		input.emit(Buffer.from("\x1b[200~第一行\nsecond line\x1b[201~"));
		output.columns = 40; output.rows = 12;
		frame = app.composeFrameForTest();
		expect(frameToText(frame)).toContain("forge-agent");
		expect(frameToText(frame)).toContain("second line");
		input.emit(Buffer.from("\r")); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		frame = app.composeFrameForTest();
		expect(frameToText(frame)).not.toContain("forge-agent");
		expect(frame.cursor!.y).toBeGreaterThanOrEqual(8);
	} finally { await app.stop(); }
});

test("dragging transcript body copies displayed text without folding or submitting", async () => {
	const { app, input, output } = createApp({ port: fakePort([
		{ type: "message_end", timestamp: 1, message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "COPY_THIS_TEXT" }] } },
	]) });
	await app.start();
	try {
		input.emit(Buffer.from("go\r")); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		const y = frameToText(app.composeFrameForTest()).split("\n").findIndex((line) => line.includes("COPY_THIS_TEXT")) + 1;
		input.emit(Buffer.from(`\x1b[<0;6;${y}M\x1b[<32;9;${y}M\x1b[<0;9;${y}m`));
		await nextTurn();
		expect(output.text).toContain(`\x1b]52;c;${Buffer.from("COPY").toString("base64")}\x07`);
		expect(frameToText(app.composeFrameForTest())).toContain("COPY_THIS_TEXT");
		expect(frameToText(app.composeFrameForTest())).toContain("Copy requested");
	} finally { await app.stop(); }
});

test("live tool details keep a paused reading position through updates, completion and resize", async () => {
	let advance: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { advance = resolve; });
	const outputBlock = (count: number, lifecycle: "streaming" | "complete") => block(
		{ id: "live", kind: "execute", lifecycle },
		{ command: "long-running-command", stdout: Array.from({ length: count }, (_, index) => `STREAM_LINE_${index}`).join("\n") },
	);
	const { app, input, output } = createApp({ port: {
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "long-running-command" }, block: outputBlock(60, "streaming"), timestamp: 1 };
			await gate;
			yield { type: "tool_execution_end", toolCallId: "live", toolName: "bash", content: "complete", isError: false, block: outputBlock(100, "complete"), timestamp: 2 };
		})()); },
	} });
	const send = (text: string) => input.emit(Buffer.from(text));
	const view = () => frameToText(app.composeFrameForTest());
	await app.start();
	try {
		send("go\r"); await waitFor(() => advance !== undefined, "() => advance !== undefined");
		send("draft\t\r");
		expect(view()).toContain("STREAM_LINE_59");
		send("k".repeat(35));
		const first = view().match(/STREAM_LINE_\d+/)?.[0];
		advance!(); await waitFor(() => !view().includes("working"), "() => !view().includes(\"working\")");
		expect(view().match(/STREAM_LINE_\d+/)?.[0]).toBe(first);
		expect(view()).not.toContain("STREAM_LINE_99");
		output.columns = 40; output.rows = 12;
		expect(view().match(/STREAM_LINE_\d+/)?.[0]).toBe(first);
		send("q");
		expect(view()).toContain("draft");
		expect(view()).toContain("long-running-command");
	} finally { advance!(); await app.stop(); }
});

test("start enters alt-screen and raw mode; Ctrl+C restores the terminal", async () => {
	const { app, input, output } = createApp();
	await app.start();
	expect(output.text).toContain(ENTER_ALT_SCREEN);
	expect(input.raw).toBe(true);
	const stopped = app.waitUntilStopped();
	input.emit(Buffer.from([0x03]));
	await stopped;
	expect(input.raw).toBe(false);
	expect(output.text.endsWith(`${LEAVE_ALT_SCREEN}`)).toBe(true);
	expect(output.count(LEAVE_ALT_SCREEN)).toBe(1);
});

test("q is draft text now; the composer chrome is painted", async () => {
	const { app, input } = createApp();
	await app.start();
	input.emit(Buffer.from("q"));
	const text = frameToText(app.composeFrameForTest());
	expect(text).toContain("╭");
	expect(text).toContain("❯ q");
	await app.stop();
	expect(app.composeFrameForTest()).toBeDefined(); // still composable after stop
});

test("submit echoes the user and paints the assistant reply", async () => {
	const userMessage = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1000 };
	const assistantDone = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello back" }], timestamp: 2000 };
	const port = fakePort([
		{ type: "agent_start", timestamp: 900 },
		{ type: "turn_start", timestamp: 900 },
		{ type: "message_start", timestamp: 1000, message: userMessage },
		{ type: "message_end", timestamp: 1001, message: userMessage },
		{ type: "message_start", timestamp: 2000, message: { role: "assistant", content: [], timestamp: 2000 } },
		{ type: "message_delta", timestamp: 2001, contentIndex: 0, contentType: "text", delta: "Hello" },
		{ type: "message_delta", timestamp: 2002, contentIndex: 0, contentType: "text", delta: " back" },
		{ type: "message_end", timestamp: 2003, message: assistantDone },
		{ type: "turn_end", timestamp: 3000, stopReason: "stop" },
		{ type: "agent_end", timestamp: 3000 },
	]);
	const { app, input } = createApp({ port });
	await app.start();
	input.emit(Buffer.from("hi"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Hello back"), "() => frameToText(app.composeFrameForTest()).includes(\"Hello back\")");
	const text = frameToText(app.composeFrameForTest());
	expect(text).toContain("❯ hi"); // user band from the event stream
	expect(text).toContain("Worked for 2.1s"); // complete execution notice
	await app.stop();
});

test("mouse wheel scrolls transcript without editing the draft", async () => {
	const { app, input, output } = createApp({ port: fakePort([
		{ type: "message_end", timestamp: 1, message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: Array.from({ length: 50 }, (_, i) => `wheel-row-${i}`).join("\n") }] } },
	]) });
	await app.start();
	try {
		input.emit(Buffer.from("go\r"));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("wheel-row-49"), "() => frameToText(app.composeFrameForTest()).includes(\"wheel-row-49\")");
		input.emit(Buffer.from("draft"));
		const before = frameToText(app.composeFrameForTest());
		input.emit(Buffer.from("\x1b[<64;10;5M"));
		const after = frameToText(app.composeFrameForTest());
		expect(after.match(/wheel-row-\d+/)?.[0]).not.toBe(before.match(/wheel-row-\d+/)?.[0]);
		expect(after).toContain("❯ draft");
		expect(after).not.toContain("64;10");
		input.emit(Buffer.from("\x1b[<65;10;5M"));
		expect(frameToText(app.composeFrameForTest())).toBe(before);
		expect(output.text).toContain("\x1b[?1000h");
		expect(output.text).toContain("\x1b[?1006h");
	} finally { await app.stop(); }
	expect(output.text).toContain("\x1b[?1000l");
	expect(output.text).toContain("\x1b[?1006l");
});

test("CJK draft editing keeps graphemes whole", async () => {
	const { app, input } = createApp();
	await app.start();
	input.emit(Buffer.from("你好"));
	expect(frameToText(app.composeFrameForTest())).toContain("❯ 你好");
	input.emit(Buffer.from([0x7f])); // backspace deletes 好, not a byte
	expect(frameToText(app.composeFrameForTest())).toContain("❯ 你");
	expect(frameToText(app.composeFrameForTest())).not.toContain("❯ 你好");
	await app.stop();
});

test("bracketed paste inserts newlines without submitting", async () => {
	const { app, input } = createApp();
	await app.start();
	input.emit(Buffer.from("\x1b[200~line1\nline2\x1b[201~"));
	const text = frameToText(app.composeFrameForTest());
	expect(text).toContain("line1");
	expect(text).toContain("line2");
	// nothing was submitted: the transcript rows above the composer stay blank
	const lines = text.split("\n");
	const transcriptLines = lines.slice(2, lines.findIndex((line) => line.includes("╭")));
	expect(transcriptLines.every((line) => line.trim() === "")).toBe(true);
	await app.stop();
});

test("slash suggestions come from the completion source, not a tui parser", async () => {
	const source: AppCompletionSource = {
		getSuggestions() {
			return { items: [{ value: "help", label: "/help", description: "Show commands" }], prefix: "/" };
		},
		applyCompletion() {
			return { input: "/help ", cursor: 6 };
		},
	};
	const { app, input } = createApp({ completionSource: source });
	await app.start();
	input.emit(Buffer.from("/"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("/help"), "() => frameToText(app.composeFrameForTest()).includes(\"/help\")");
	input.emit(Buffer.from("\r")); // applies, does not submit
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("❯ /help"), "() => frameToText(app.composeFrameForTest()).includes(\"❯ /help\")");
	await app.stop();
});

test("Enter queues while a turn is running; Ctrl+Enter aborts and sends", async () => {
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const port: AppPort = {
		runTurn(input: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			calls.push(input);
			yield { type: "turn_start", timestamp: 1 };
			if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
			yield { type: "turn_end", timestamp: 2, stopReason: calls.length === 1 ? "aborted" : "stop" };
		})()); },
		abort() {
			release?.();
		},
	};
	const { app, input } = createApp({ port });
	await app.start();
	input.emit(Buffer.from("first"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => calls.length === 1, "() => calls.length === 1");
	input.emit(Buffer.from("second"));
	input.emit(Buffer.from("\r")); // queue
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("queued") || frameToText(app.composeFrameForTest()).includes("working"), "() => frameToText(app.composeFrameForTest()).includes(\"queued\") || frameToText(app.composeFrameForTest()).includes(\"working\")");
	input.emit(Buffer.from("third"));
	input.emit(Buffer.from("\x1b[13;5u")); // ctrl+enter: abort and send third
	await waitFor(() => calls.includes("third"), "() => calls.includes(\"third\")");
	expect(calls[0]).toBe("first");
	expect(calls.at(-1)).toBe("third");
	expect(frameToText(app.composeFrameForTest())).toContain("second");
	await app.stop();
});

test("ADR010: Esc during saving restores queued input and draft without autosending", async () => {
	const calls: string[] = [];
	let release!: () => void;
	const { app, input } = createApp({ port: {
		runTurn(value: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> { calls.push(value); yield { type: "agent_end", timestamp: 1 }; await new Promise<void>((resolve) => { release = resolve; }); })()); },
		abort() {},
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined, "() => release !== undefined");
		input.emit(Buffer.from("second\rthird\rdraft"));
		expect(frameToText(app.composeFrameForTest())).toContain("second");
		input.emit(Buffer.from("\x1b"));
		await Bun.sleep(40);
		release();
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		expect(calls).toEqual(["first"]);
		const text = frameToText(app.composeFrameForTest());
		expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"));
		expect(text.indexOf("third")).toBeLessThan(text.indexOf("draft"));
	} finally { release?.(); await app.stop(); }
});

test("ADR010: saving failure retains the selected replacement and older queue as drafts", async () => {
	const calls: string[] = [];
	let release!: () => void;
	const { app, input } = createApp({ port: {
		runTurn(value: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			calls.push(value);
			yield { type: "agent_end", timestamp: 1 };
			await new Promise<void>((resolve) => { release = resolve; });
			throw new Error("disk failed");
		})()); },
		abort() {},
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined, "() => release !== undefined");
		input.emit(Buffer.from("second\rthird\x1b[13;5u"));
		release();
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("disk failed"), "() => frameToText(app.composeFrameForTest()).includes(\"disk failed\")");
		expect(calls).toEqual(["first"]);
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("second");
		expect(text).toContain("third");
	} finally { release?.(); await app.stop(); }
});

test("ADR010: empty composer Up withdraws queued input for editing", async () => {
	const calls: string[] = [];
	let release!: () => void;
	const { app, input } = createApp({ port: {
		runTurn(value: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> { calls.push(value); if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; }); })()); },
		abort() { release?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined, "() => release !== undefined");
		input.emit(Buffer.from("second\r\x1b[A"));
		expect(frameToText(app.composeFrameForTest())).toContain("❯ second");
		input.emit(Buffer.from(" edited\r"));
		release();
		await waitFor(() => calls.length === 2, "() => calls.length === 2");
		expect(calls).toEqual(["first", "second edited"]);
	} finally { release?.(); await app.stop(); }
});

test("ADR010: a rejected invocation restores its input instead of clearing the composer", async () => {
	const { app, input } = createApp({ port: {
		runTurn() { throw new Error("Agent is faulted; recreate it from storage"); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("recoverable\r"));
		expect(frameToText(app.composeFrameForTest())).toContain("❯ recoverable");
	} finally { await app.stop(); }
});

for (const phase of ["stream", "tool"] as const) test(`ADR010: ordinary stop during ${phase} preserves input arriving during cleanup`, async () => {
	let cancel!: () => void;
	let finish!: () => void;
	let cleaning = false;
	const calls: string[] = [];
	const cleanup = new Promise<void>((resolve) => { finish = resolve; });
	const { app, input } = createApp({ port: {
		runTurn(value: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			calls.push(value);
			if (phase === "stream") yield { type: "message_delta", contentIndex: 0, contentType: "text", delta: "partial", timestamp: 1 };
			else yield { type: "tool_execution_start", toolCallId: "hold", toolName: "hold", args: {}, timestamp: 1 };
			await new Promise<void>((resolve) => { cancel = resolve; });
			cleaning = true;
			await cleanup;
			yield { type: "turn_end", stopReason: "aborted", timestamp: 2 };
		})()); },
		abort() { cancel?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => cancel !== undefined, "() => cancel !== undefined");
		input.emit(Buffer.from("queued\r\x1b"));
		await waitFor(() => cleaning, "() => cleaning");
		expect(frameToText(app.composeFrameForTest())).toContain("❯ queued");
		input.emit(Buffer.from(" during cleanup\r"));
		finish();
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("stopping"), "() => !frameToText(app.composeFrameForTest()).includes(\"stopping\")");
		expect(calls).toEqual(["first"]);
		expect(frameToText(app.composeFrameForTest())).toContain("❯ queued during cleanup");
	} finally { cancel?.(); finish(); await app.stop(); }
});

test("repeated Enter submissions run in FIFO order", async () => {
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const { app, input } = createApp({ port: {
		runTurn(value: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			calls.push(value);
			if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
		})()); },
		abort() { release?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined, "() => release !== undefined");
		input.emit(Buffer.from("second\rthird\r"));
		release?.();
		await waitFor(() => calls.length === 3 && !frameToText(app.composeFrameForTest()).includes("working"), "() => calls.length === 3 && !frameToText(app.composeFrameForTest()).includes(\"working\")");
		expect(calls).toEqual(["first", "second", "third"]);
	} finally { await app.stop(); }
});

test("stop aborts and waits for the active turn and never starts queued input", async () => {
	const calls: string[] = [];
	let release: (() => void) | undefined;
	let aborted = false;
	let settled = false;
	const { app, input } = createApp({ port: {
		runTurn(value: string) { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			calls.push(value);
			await new Promise<void>((resolve) => { release = resolve; });
			await nextTurn();
			settled = true;
		})()); },
		abort() { aborted = true; release?.(); },
	} });
	await app.start();
	input.emit(Buffer.from("first\r"));
	await waitFor(() => release !== undefined, "() => release !== undefined");
	input.emit(Buffer.from("queued\r"));
	await app.stop();
	try {
		expect(aborted).toBe(true);
		expect(settled).toBe(true);
		expect(calls).toEqual(["first"]);
	} finally { release?.(); }
});

test("completion results cannot replace a newer draft or reopen after submit", async () => {
	const pending = new Map<string, (value: ReturnType<AppCompletionSource["getSuggestions"]>) => void>();
	const source: AppCompletionSource = {
		getSuggestions(value) { return new Promise((resolve) => pending.set(value, resolve)); },
		applyCompletion() { throw new Error("unexpected completion"); },
	};
	const { app, input } = createApp({ completionSource: source });
	await app.start();
	try {
		input.emit(Buffer.from("a"));
		input.emit(Buffer.from("b"));
		await nextTurn();
		pending.get("ab")?.(null);
		await nextTurn();
		pending.get("a")?.({ items: [{ value: "stale", label: "STALE_COMPLETION" }], prefix: "a" });
		await nextTurn();
		expect(frameToText(app.composeFrameForTest())).not.toContain("STALE_COMPLETION");
		input.emit(Buffer.from("c\r"));
		await nextTurn();
		pending.get("abc")?.({ items: [{ value: "stale", label: "STALE_COMPLETION" }], prefix: "abc" });
		await nextTurn();
		expect(frameToText(app.composeFrameForTest())).not.toContain("STALE_COMPLETION");
	} finally { await app.stop(); }
});

test.each([false, true])("failed settlement restores only unprocessed input: processed=%s", async processed => {
	const calls: string[] = [];
	let finish!: () => void;
	let ready = false;
	const gate = new Promise<void>(resolve => { finish = resolve; });
	const { app, input } = createApp({ port: {
		runTurn(value) {
			if (typeof value !== "string") throw new Error("This fixture accepts text inputs");
			calls.push(value);
			return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
				if (processed) yield { type: "message_start", message: { role: "user", content: [{ type: "text", text: value }], timestamp: 1 }, timestamp: 1 };
				ready = true;
				await gate;
				throw new Error("save failed after input processing");
			})());
		},
	} });
	await app.start();
	try {
		input.emit(Buffer.from("original\r"));
		await waitFor(() => ready, "() => ready");
		input.emit(Buffer.from("queued\rselected\x1b[13;5u"));
		finish();
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("save failed"), "() => frameToText(app.composeFrameForTest()).includes(\"save failed\")");
		expect(calls).toEqual(["original"]);
		const frame = frameToText(app.composeFrameForTest());
		expect(frame).toContain(processed ? "❯ queued" : "❯ original");
		expect(frame).toContain("selected");
	} finally { finish(); await app.stop(); }
});
