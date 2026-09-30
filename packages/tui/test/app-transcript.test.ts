import { block, type SessionEvent, type SessionMessage } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import { scriptedTurn } from "../../../tests/support/turn.ts";
import { frameToText } from "../src/index.ts";

import { nextTurn, waitFor } from "../../../tests/support/control.ts";
import { createApp, fakePort } from "./helpers/app.ts";

test("selecting an adjacent reply never paints over the user message band", async () => {
	for (const [columns, rows] of [[120, 32], [80, 24], [40, 12]]) {
		const { app, input, output } = createApp({ history: [
			{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", timestamp: 2, content: [{ type: "text", text: "I will update the sample, check the command output, and write the result." }] },
		] });
		output.columns = columns!; output.rows = rows!;
		await app.start();
		try {
			const before = app.composeFrameForTest();
			const userY = frameToText(before).split("\n").findIndex((line) => line.includes("hello"));
			expect(userY).toBeGreaterThanOrEqual(0);
			input.emit(Buffer.from("\t"));
			const after = app.composeFrameForTest();
			for (const y of [userY - 1, userY, userY + 1].filter((y) => y >= 0)) expect(after.cells[y]).toEqual(before.cells[y]);
			const lines = frameToText(after).split("\n");
			const cornerY = lines.findIndex((line) => line.includes("┌"));
			expect(cornerY).toBeGreaterThan(userY + 1);
			expect(lines[cornerY + 1]).toContain("I will update");
			input.emit(Buffer.from("\r"));
			input.emit(Buffer.from("q"));
			expect(app.composeFrameForTest().cells).toEqual(after.cells);
		} finally { await app.stop(); }
	}
});

test("selection borders do not occupy an adjacent compact tool row without a gap", async () => {
	const { app, input } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [
		{ type: "tool_call", id: "run", name: "bash", arguments: { command: "pwd" } },
		{ type: "tool_call", id: "read", name: "read", arguments: { path: "sample.ts" } },
	] }] });
	await app.start();
	try {
		const before = app.composeFrameForTest();
		const runY = frameToText(before).split("\n").findIndex((line) => line.includes("Run pwd"));
		expect(runY).toBeGreaterThanOrEqual(0);
		input.emit(Buffer.from("\t"));
		expect(app.composeFrameForTest().cells[runY]).toEqual(before.cells[runY]);
	} finally { await app.stop(); }
});

test("ordinary operations are compact rows and never reveal write content in their titles", async () => {
	const events: SessionEvent[] = [
		{ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "sample.ts", old_text: "old", new_text: "new" }, timestamp: 1 },
		{ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", content: "edited", isError: false, timestamp: 2 },
		{ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: { command: "printf output", description: "Check preview response" }, timestamp: 3 },
		{ type: "tool_execution_end", toolCallId: "run", toolName: "bash", content: "output", isError: false, timestamp: 4 },
		{ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "created.txt", content: "PRIVATE_BODY" }, timestamp: 5 },
		{ type: "tool_execution_end", toolCallId: "write", toolName: "write", content: "written", isError: false, timestamp: 6 },
	];
	const { app, input } = createApp({ port: fakePort(events) });
	await app.start();
	try {
		input.emit(Buffer.from("go\r")); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("Run Check preview response");
		expect(text).toContain("Write created.txt");
		expect(text).not.toContain("1 calls");
		expect(text).not.toContain("PRIVATE_BODY");
		expect(text.split("\n").filter((line) => /Edit sample|Run Check|Write created/.test(line))).toHaveLength(3);
		input.emit(Buffer.from("\t\r"));
		expect(frameToText(app.composeFrameForTest())).toContain("PRIVATE_BODY");
		input.emit(Buffer.from("qke"));
		expect(frameToText(app.composeFrameForTest())).toContain("$ printf output");
		input.emit(Buffer.from("\r"));
		expect(frameToText(app.composeFrameForTest())).toContain("$ printf output");
	} finally { await app.stop(); }
});

test("exploration summary combines read and search while operations remain separate", async () => {
	const events: SessionEvent[] = [
		...(["read", "search", "read"] as const).flatMap((name, index): SessionEvent[] => [
			{ type: "tool_execution_start", toolCallId: `explore-${index}`, toolName: name, args: { path: `file-${index}.ts`, pattern: "needle" }, timestamp: 1 },
			{ type: "tool_execution_end", toolCallId: `explore-${index}`, toolName: name, content: "BODY", isError: false, timestamp: 2 },
		]),
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Ready to edit" }], timestamp: 3 }, timestamp: 3 },
	];
	const { app, input } = createApp({ port: fakePort(events) });
	const send = (text: string) => input.emit(Buffer.from(text));
	const text = () => frameToText(app.composeFrameForTest());
	await app.start();
	try {
		send("go\r"); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		expect(text()).toContain("Read 2 files, Searched 1 pattern");
		expect(text()).not.toContain("file-0.ts");
		send("\tkl");
		expect(text()).toContain("file-0.ts");
		expect(text()).not.toContain("BODY");
		send("je");
		expect(text()).toContain("BODY");
		expect(text()).toContain("Searched 1 pattern, Read 1 file");
		send("e");
		expect(text()).toContain("Read 2 files, Searched 1 pattern");
		expect(text()).toContain("file-2.ts");
	} finally { await app.stop(); }
});

test("long dense runs keep ten recent operations and allow opening an older call", async () => {
	const history: SessionMessage[] = [{ role: "assistant", timestamp: 1, content: Array.from({ length: 12 }, (_, index) => ({
		type: "tool_call" as const, id: `dense-${index}`, name: "bash", arguments: { command: `echo step-${index}` },
	})) }];
	const { app, input, output } = createApp({ history });
	output.rows = 32;
	await app.start();
	try {
		const text = () => frameToText(app.composeFrameForTest());
		expect(text()).toContain("2 earlier steps");
		expect(text()).not.toContain("Run echo step-0");
		expect(text()).toContain("Run echo step-2");
		input.emit(Buffer.from("\t" + "k".repeat(10) + "l"));
		expect(text()).toContain("Run echo step-0");
		input.emit(Buffer.from("j\r"));
		expect(text()).toContain("Run echo step-0");
		input.emit(Buffer.from("q"));
		expect(text()).toContain("2 earlier steps");
	} finally { await app.stop(); }
});

test("custom tool names matching object properties remain ordinary tool calls", async () => {
	const { app } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [
		{ type: "tool_call", id: "custom", name: "constructor", arguments: { path: "result.txt" } },
	] }] });
	await app.start();
	try {
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("constructor result.txt");
		expect(text).not.toContain("undefined");
	} finally { await app.stop(); }
});

test("a completed thought before exploration belongs to its summary and remains accessible", async () => {
	const { app, input } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [
		{ type: "thinking", thinking: "Plan the inspection" },
		{ type: "tool_call", id: "read-after-thought", name: "read", arguments: { path: "sample.ts" } },
	] }] });
	await app.start();
	try {
		expect(frameToText(app.composeFrameForTest())).toContain("Read 1 file");
		expect(frameToText(app.composeFrameForTest())).not.toContain("Thought");
		input.emit(Buffer.from("\tl"));
		expect(frameToText(app.composeFrameForTest())).toContain("Thought");
		input.emit(Buffer.from("j\r"));
		expect(frameToText(app.composeFrameForTest())).toContain("Plan the inspection");
	} finally { await app.stop(); }
});

test("tool call group and member selection remain distinct, double-click folds only once", async () => {
	const events: SessionEvent[] = Array.from({ length: 10 }, (_, index) => `file-${index}`).flatMap((id) => [
		{ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` }, timestamp: 1 },
		{ type: "tool_execution_end", toolCallId: id, toolName: "read", content: JSON.stringify({ content: `BODY-${id}` }), isError: id === "file-4", timestamp: 2 },
	]);
	const { app, input } = createApp({ port: fakePort(events) });
	const view = () => frameToText(app.composeFrameForTest());
	const send = (text: string) => input.emit(Buffer.from(text));
	await app.start();
	try {
		send("go\r"); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		expect(view()).toContain("Read 10 files");
		expect(view()).toContain("1 failed");
		send("\tl");
		const y = view().split("\n").findIndex((line) => line.includes("Read file-3.ts")) + 1;
		expect(y).toBeGreaterThan(0);
		const click = `\x1b[<0;7;${y}M\x1b[<0;7;${y}m`;
		send(click);
		expect(view()).not.toContain("BODY-file-3");
		send(click);
		expect(view()).toContain("BODY-file-3");
		send("\r");
		expect(view()).toContain("BODY-file-3");
		send("qh");
		expect(view()).toContain("Read 10 files");
	} finally { await app.stop(); }
});

test("existing session opens directly in history and failed edit details retain the error", async () => {
	const { app, input } = createApp({ showWelcome: true, history: [
		{ role: "user", content: [{ type: "text", text: "Earlier task" }], timestamp: 1 },
	], port: fakePort([
		{ type: "tool_execution_start", toolCallId: "edit-error", toolName: "edit", args: { path: "a.ts" }, timestamp: 2,
			block: block({ id: "edit-error", kind: "edit", lifecycle: "streaming" }, { path: "a.ts", additions: 0, removals: 0, hunks: [] }) },
		{ type: "tool_execution_end", toolCallId: "edit-error", toolName: "edit", content: "EDIT_NOT_FOUND: missing fragment", isError: true, timestamp: 3 },
	]) });
	await app.start();
	try {
		expect(frameToText(app.composeFrameForTest())).toContain("Earlier task");
		expect(frameToText(app.composeFrameForTest())).not.toMatch(/[▀▄█]/);
		input.emit(Buffer.from("go\r")); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		input.emit(Buffer.from("\t\r"));
		expect(frameToText(app.composeFrameForTest())).toContain("EDIT_NOT_FOUND: missing fragment");
	} finally { await app.stop(); }
});

test("replayed read retains its name, grouping and numbered details without a result toolName", async () => {
	const { app, input } = createApp({ history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "tool_call", id: "old-read", name: "read", arguments: { path: "file.txt", offset: 12 } }] },
		{ role: "toolResult", timestamp: 2, toolCallId: "old-read", content: [{ type: "text", text: JSON.stringify({ content: "saved line\nnext line" }) }] },
	] });
	await app.start();
	try {
		expect(frameToText(app.composeFrameForTest())).toContain("Read 1 file");
		input.emit(Buffer.from("\t\r\r"));
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("Read file.txt");
		expect(text).toContain("12  saved line");
		expect(text).toContain("13  next line");
		expect(text).not.toContain('"content"');
	} finally { await app.stop(); }
});

test("replayed shell tools show command and decoded output in details", async () => {
	const { app, input } = createApp({ showWelcome: true, history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "tool_call", id: "old-run", name: "bash", arguments: { command: "printf hello" } }] },
		{ role: "toolResult", timestamp: 2, toolCallId: "old-run", content: [{ type: "text", text: JSON.stringify({ command: "printf hello", stdout: "hello\nworld", stderr: "", exitCode: 0 }) }] },
	] });
	await app.start();
	try {
		input.emit(Buffer.from("\t\r"));
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("Run printf hello");
		expect(text).toContain("world");
		expect(text).not.toContain('"stdout"');
	} finally { await app.stop(); }
});

test("detail drag selection includes the final character of a full-width row", async () => {
	const body = `${"a".repeat(73)}Z`;
	const { app, input, output } = createApp({ history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "text", text: body }] },
	] });
	await app.start();
	try {
		input.emit(Buffer.from("\t\r"));
		input.emit(Buffer.from("\x1b[<0;4;3M\x1b[<32;77;3M\x1b[<0;77;3m"));
		await nextTurn();
		expect(output.text.includes(`\x1b]52;c;${Buffer.from(body).toString("base64")}\x07`)).toBe(true);
	} finally { await app.stop(); }
});

test("detail search navigates matching fragments inside a long wrapped line", async () => {
	const { app, input, output } = createApp({ history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "text", text: `${"A".repeat(1600)}NEEDLE_A${"B".repeat(800)}NEEDLE_B` }] },
	] });
	output.columns = 40; output.rows = 12;
	const send = (text: string) => input.emit(Buffer.from(text));
	const view = () => frameToText(app.composeFrameForTest());
	await app.start();
	try {
		send("\t\r/NEEDLE\r");
		expect(view()).toContain("NEEDLE_A");
		send("n");
		expect(view().replace(/\s/g, "")).toContain("NEEDLE_B");
		send("N");
		expect(view()).toContain("NEEDLE_A");
		send("w");
		expect(view()).toContain("NEEDLE_A");
	} finally { await app.stop(); }
});

test("/clear removes displayed history while later replies still appear", async () => {
	const { app, input } = createApp({
		history: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "OLDER_SESSION_TEXT" }] }],
		port: fakePort([{ type: "message_end", timestamp: 2, message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "NEW_REPLY" }] } }]),
	});
	await app.start();
	try {
		expect(frameToText(app.composeFrameForTest())).toContain("OLDER_SESSION_TEXT");
		input.emit(Buffer.from("/clear\r"));
		const cleared = frameToText(app.composeFrameForTest());
		expect(cleared).not.toContain("OLDER_SESSION_TEXT");
		expect(cleared).toContain("已清屏，上下文仍保留");
		input.emit(Buffer.from("go\r"));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("NEW_REPLY"), "() => frameToText(app.composeFrameForTest()).includes(\"NEW_REPLY\")");
		expect(frameToText(app.composeFrameForTest())).not.toContain("OLDER_SESSION_TEXT");
	} finally { await app.stop(); }
});

test("selected execute expands with e while the removed ctrl+o binding is inert", async () => {
	const executeBlock = block(
		{ id: "call-1", kind: "execute", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false },
		{ command: "ls", stdout: "1\n2\n3\n4\n5\n6\n7\n8\n", exitCode: 0 },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3 },
	);
	const port = fakePort([
		{ type: "tool_execution_start", timestamp: 1, toolCallId: "call-1", toolName: "bash", args: { command: "ls" }, block: executeBlock },
		{ type: "turn_end", timestamp: 2, stopReason: "stop" },
	]);
	const { app, input } = createApp({ port });
	await app.start();
	input.emit(Buffer.from("go"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Run ls"), "() => frameToText(app.composeFrameForTest()).includes(\"Run ls\")");
	expect(frameToText(app.composeFrameForTest())).not.toMatch(/│\s+1\s+│/);
	input.emit(Buffer.from([0x0f])); // ctrl+o
	expect(frameToText(app.composeFrameForTest())).toContain("Run ls");
	expect(frameToText(app.composeFrameForTest())).not.toMatch(/│\s+1\s+│/);
	input.emit(Buffer.from("\te"));
	expect(frameToText(app.composeFrameForTest())).toMatch(/│\s+1\s+│/);
	input.emit(Buffer.from("e"));
	expect(frameToText(app.composeFrameForTest())).not.toMatch(/│\s+1\s+│/);
	await app.stop();
});

test("read result is hidden until manually expanded", async () => {
	const result = "READ_BODY_SENTINEL";
	const { app, input } = createApp({ port: fakePort([
		{ type: "message_end", timestamp: 1, message: { role: "assistant", timestamp: 1, content: [{ type: "tool_call", id: "read-1", name: "read", arguments: { path: "file.txt" } }] } },
		{ type: "tool_execution_start", timestamp: 2, toolCallId: "read-1", toolName: "read", args: { path: "file.txt" } },
		{ type: "tool_execution_end", timestamp: 3, toolCallId: "read-1", toolName: "read", content: result, isError: false },
		{ type: "message_end", timestamp: 4, message: { role: "toolResult", toolCallId: "read-1", toolName: "read", timestamp: 4, content: [{ type: "text", text: result }] } },
	]) });
	await app.start();
	try {
		input.emit(Buffer.from("go\r"));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Read 1 file"), "() => frameToText(app.composeFrameForTest()).includes(\"Read 1 file\")");
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		expect(frameToText(app.composeFrameForTest())).not.toContain(result);
		input.emit(Buffer.from("\tlje"));
		expect(frameToText(app.composeFrameForTest())).toContain(result);
		input.emit(Buffer.from("e"));
		expect(frameToText(app.composeFrameForTest())).not.toContain(result);
	} finally { await app.stop(); }
});

test("transcript reflow keeps the same logical line across wide and narrow windows", async () => {
	const lines = Array.from({ length: 70 }, (_, index) => `ROW_${String(index).padStart(3, "0")} ${"x".repeat(80)}`);
	for (const kind of ["code", "prose", "read"] as const) {
		const history: SessionMessage[] = kind === "read" ? [
			{ role: "assistant", timestamp: 1, content: [{ type: "tool_call", id: "long-read", name: "read", arguments: { path: "long.txt" } }] },
			{ role: "toolResult", timestamp: 2, toolCallId: "long-read", content: [{ type: "text", text: JSON.stringify({ content: lines.join("\n") }) }] },
		] : [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: kind === "code" ? `\`\`\`\n${lines.join("\n")}\n\`\`\`` : lines.join("\n") }] }];
		const { app, input, output } = createApp({ history });
		output.columns = 120;
		await app.start();
		try {
			if (kind === "read") input.emit(Buffer.from("\t\rl\x1b[6~\x1b[6~\x1b[6~"));
			input.emit(Buffer.from("\x1b[5~"));
			const firstLine = () => frameToText(app.composeFrameForTest()).match(/ROW_\d+/)?.[0];
			const before = firstLine();
			expect(before).toBeDefined();
			expect(before).not.toBe("ROW_000");
			for (const columns of [40, 80, 120]) {
				output.columns = columns;
				expect(firstLine()).toBe(before);
			}
		} finally { await app.stop(); }
	}
});

test("repeated resize preserves a position inside one long line until the user scrolls", async () => {
	const text = Array.from({ length: 900 }, (_, index) => `W${String(index).padStart(4, "0")}_`).join("");
	const { app, input, output } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: `\`\`\`\n${text}\n\`\`\`` }] }] });
	output.columns = 120;
	await app.start();
	try {
		input.emit(Buffer.from("\x1b[5~"));
		const firstLine = () => frameToText(app.composeFrameForTest()).split("\n").find((line) => /W\d{4}_/.test(line));
		const before = firstLine();
		expect(before).toBeDefined();
		for (let cycle = 0; cycle < 3; cycle++) {
			for (const columns of [40, 80, 120]) { output.columns = columns; app.composeFrameForTest(); }
			expect(firstLine()).toBe(before);
		}
		input.emit(Buffer.from("\x1b[5~"));
		const afterScroll = firstLine();
		expect(afterScroll).not.toBe(before);
		for (const columns of [40, 80, 120]) { output.columns = columns; app.composeFrameForTest(); }
		expect(firstLine()).toBe(afterScroll);
	} finally { await app.stop(); }
});

test("scrollback stays anchored during streaming and cannot paint over the header", async () => {
	let advance: (() => void) | undefined;
	const first = Array.from({ length: 50 }, (_, index) => `row-${index}`).join("\n");
	const { app, input } = createApp({ port: {
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } };
			yield { type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: first };
			await new Promise<void>((resolve) => { advance = resolve; });
			yield { type: "message_delta", timestamp: 3, contentIndex: 0, contentType: "text", delta: "\nnew-row-a\nnew-row-b" };
		})()); },
		abort() { advance?.(); },
	} });
	await app.start();
	try {
		const header = frameToText(app.composeFrameForTest()).split("\n")[0];
		input.emit(Buffer.from("go\r"));
		await waitFor(() => advance !== undefined, "() => advance !== undefined");
		input.emit(Buffer.from("\x1b[5~"));
		const before = frameToText(app.composeFrameForTest()).split("\n");
		advance?.();
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		const after = frameToText(app.composeFrameForTest()).split("\n");
		expect(after[1]).toBe(before[1]);
		expect(after[0]).toBe(header);
	} finally { await app.stop(); }
});

test("assistant details render Markdown and both views copy original emphasis", async () => {
	const body = "**COPY_THIS_TEXT**";
	const { app, input, output } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: body }] }] });
	await app.start();
	try {
		for (const detail of [false, true]) {
			if (detail) input.emit(Buffer.from("\r"));
			const frame = app.composeFrameForTest();
			const lines = frameToText(frame).split("\n");
			const row = lines.findIndex(line => line.includes("COPY_THIS_TEXT"));
			expect(lines[row]).not.toContain("**");
			const x = lines[row]!.indexOf("COPY_THIS_TEXT") + 1;
			input.emit(Buffer.from(`\x1b[<0;${x};${row + 1}M\x1b[<32;${x + 3};${row + 1}M\x1b[<0;${x + 3};${row + 1}m`));
			await nextTurn();
			expect(output.chunks.slice(-8).join("")).toContain(`\x1b]52;c;${Buffer.from(body).toString("base64")}\x07`);
		}
	} finally { await app.stop(); }
});

test("Markdown source selection spans wrapped plain text, tables and code without screen decorations", async () => {
	for (const body of ["> | A | B |\n> | --- | --- |\n> | x | y |", "- | A | B |\n  | --- | --- |\n  | x | y |", "> ```ts\n> const x = 1;\n> const y = 2;\n> ```", "- ```ts\n  const x = 1;\n  const y = 2;\n  ```", "abcdefghijklmnopqrstuvwx", "> hello\n> world", "```ts\nconst answer = 42;\n```", "| Name | State |\n| --- | --- |\n| Markdown | ready |", "before\r\nafter"]) {
		const { app, input, output } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: body }] }] });
		await app.start();
		try {
			input.emit(Buffer.from("\t\r"));
			const frame = app.composeFrameForTest();
			const rows = frame.cells.map((cells, y) => ({ cells, y })).filter(row => row.cells.some(cell => cell.source));
			expect(rows.length).toBeGreaterThan(0);
			const first = rows[0]!, last = rows.at(-1)!;
			const x1 = first.cells.findIndex(cell => cell.source);
			const x2 = last.cells.length - 1 - [...last.cells].reverse().findIndex(cell => cell.source);
			input.emit(Buffer.from(`\x1b[<0;${x1 + 1};${first.y + 1}M\x1b[<32;${x2 + 1};${last.y + 1}M\x1b[<0;${x2 + 1};${last.y + 1}m`));
			await nextTurn();
			const expected = body;
			expect(output.text.includes(`\x1b]52;c;${Buffer.from(expected).toString("base64")}\x07`)).toBe(true);
		} finally { await app.stop(); }
	}
});

test("streaming Markdown preserves a selection snapshot and paused assistant detail through reflow", async () => {
	let advance: (() => void) | undefined;
	const first = "**COPY_THIS_TEXT" + Array.from({ length: 45 }, (_, i) => `\nLINE_${i} content`).join("");
	const final = first + "**\n\n| Name | State |\n| --- | --- |\n| final | ready |";
	const { app, input, output } = createApp({ port: {
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } };
			yield { type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: first };
			await new Promise<void>(resolve => { advance = resolve; });
			yield { type: "message_delta", timestamp: 3, contentIndex: 0, contentType: "text", delta: final.slice(first.length) };
			yield { type: "message_end", timestamp: 4, message: { role: "assistant", content: [{ type: "text", text: final }], timestamp: 1 } };
		})()); }, abort() { advance?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("go\r")); await waitFor(() => advance !== undefined, "() => advance !== undefined");
		input.emit(Buffer.from("draft\t\r"));
		input.emit(Buffer.from("k".repeat(35)));
		const before = frameToText(app.composeFrameForTest()).match(/LINE_\d+/)?.[0];
		expect(before).toBeDefined();
		const text = frameToText(app.composeFrameForTest()).split("\n");
		const y = text.findIndex(line => line.includes(before!));
		const x = text[y]!.indexOf(before!);
		input.emit(Buffer.from(`\x1b[<0;${x + 1};${y + 1}M`));
		advance!(); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		input.emit(Buffer.from(`\x1b[<32;${x + before!.length};${y + 1}M\x1b[<0;${x + before!.length};${y + 1}m`));
		await nextTurn();
		expect(output.text).toContain(`\x1b]52;c;${Buffer.from(before!).toString("base64")}\x07`);
		expect(frameToText(app.composeFrameForTest()).match(/LINE_\d+/)?.[0]).toBe(before);
		output.columns = 40; output.rows = 12;
		expect(frameToText(app.composeFrameForTest()).match(/LINE_\d+/)?.[0]).toBe(before);
		input.emit(Buffer.from("q"));
		expect(frameToText(app.composeFrameForTest())).toContain("draft");
	} finally { advance?.(); await app.stop(); }
});

test("assistant detail keyboard selection copies complete fenced source", async () => {
	const body = "```ts\nconst x = 1;\n```";
	const { app, input, output } = createApp({ history: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: body }] }] });
	await app.start();
	try {
		input.emit(Buffer.from("\t\rvy")); await nextTurn();
		expect(output.text).toContain(`\x1b]52;c;${Buffer.from(body).toString("base64")}\x07`);
	} finally { await app.stop(); }
});

test("assistant detail keyboard selection freezes the selected streaming source", async () => {
	let advance: (() => void) | undefined;
	const { app, input, output } = createApp({ port: {
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } };
			yield { type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "hello" };
			await new Promise<void>(resolve => { advance = resolve; });
			yield { type: "message_delta", timestamp: 3, contentIndex: 0, contentType: "text", delta: " appended" };
		})()); }, abort() { advance?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("go\r")); await waitFor(() => advance !== undefined, "() => advance !== undefined");
		input.emit(Buffer.from("\t\rv"));
		advance!(); await waitFor(() => !frameToText(app.composeFrameForTest()).includes("working"), "() => !frameToText(app.composeFrameForTest()).includes(\"working\")");
		input.emit(Buffer.from("y")); await nextTurn();
		expect(output.text).toContain(`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
	} finally { advance?.(); await app.stop(); }
});
