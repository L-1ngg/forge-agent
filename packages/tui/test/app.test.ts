import { expect, test } from "bun:test";
import { block, request, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type ResponseEnvelope, type SessionEvent, type SessionMessage } from "@forge-agent/protocol";
import { App, computeScreenLayout, frameToText, type AppCompletionSource, type AppPort, type AppRequestBus } from "../src/index.ts";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../src/ansi.ts";
import type { HostInput, HostOutput } from "../src/host.ts";

class FakeInput implements HostInput {
	raw: boolean | undefined;
	private listeners: ((chunk: Buffer) => void)[] = [];
	setRawMode(raw: boolean): void {
		this.raw = raw;
	}
	on(_event: "data", listener: (chunk: Buffer) => void): void {
		this.listeners.push(listener);
	}
	off(_event: "data", listener: (chunk: Buffer) => void): void {
		this.listeners = this.listeners.filter((candidate) => candidate !== listener);
	}
	resume(): void {}
	pause(): void {}
	emit(chunk: Buffer): void {
		for (const listener of [...this.listeners]) listener(chunk);
	}
}

class FakeOutput implements HostOutput {
	readonly chunks: string[] = [];
	columns = 80;
	rows = 24;
	write(text: string): void {
		this.chunks.push(text);
	}
	get text(): string {
		return this.chunks.join("");
	}
	count(needle: string): number {
		return this.chunks.filter((chunk) => chunk.includes(needle)).length;
	}
}

class FakeBus implements AppRequestBus {
	acceptResponses = true;
	private closed = false;
	readonly responses: ResponseEnvelope[] = [];
	private readonly envelopes: RequestEnvelopeUnion[] = [];
	private readonly terminalOutcomes: RequestOutcome<RequestKind>[] = [];
	private notify: (() => void) | undefined;
	private notifyTerminal: (() => void) | undefined;

	push(envelope: RequestEnvelopeUnion): void {
		this.envelopes.push(envelope);
		this.notify?.();
	}

	pushTerminal(outcome: RequestOutcome<RequestKind>): void {
		this.terminalOutcomes.push(outcome);
		this.notifyTerminal?.();
	}

	respond(value: unknown): boolean {
		this.responses.push(value as ResponseEnvelope);
		return this.acceptResponses;
	}

	close(): void {
		this.closed = true;
		this.notify?.();
		this.notifyTerminal?.();
	}

	getTerminal(id: string): RequestOutcome<RequestKind> | undefined {
		return this.terminalOutcomes.find((outcome) => outcome.requestId === id);
	}

	async *requests(): AsyncIterable<RequestEnvelopeUnion> {
		let index = 0;
		while (!this.closed) {
			if (index < this.envelopes.length) {
				yield this.envelopes[index]!;
				index++;
			} else {
				await new Promise<void>((resolve) => {
					this.notify = resolve;
				});
			}
		}
	}

	async *terminals(): AsyncIterable<RequestOutcome<RequestKind>> {
		let index = 0;
		while (!this.closed) {
			if (index < this.terminalOutcomes.length) {
				yield this.terminalOutcomes[index]!;
				index++;
			} else {
				await new Promise<void>((resolve) => {
					this.notifyTerminal = resolve;
				});
			}
		}
	}
}

function fakePort(events: SessionEvent[]): AppPort {
	return {
		async *runTurn() {
			for (const event of events) yield event;
		},
	};
}

function createApp(options: { port?: AppPort; bus?: FakeBus; completionSource?: AppCompletionSource; showWelcome?: boolean; history?: readonly SessionMessage[] } = {}) {
	const input = new FakeInput();
	const output = new FakeOutput();
	const bus = options.bus ?? new FakeBus();
	const app = new App({
		port: options.port ?? fakePort([]),
		host: "alt",
		requestBus: bus,
		cwd: "/tmp/proj",
		homeDir: "/tmp",
		getStatus: () => ({ provider: "faux", model: "faux-1" }),
		stdin: input,
		stdout: output,
		env: { COLORTERM: "truecolor" },
		...(options.completionSource ? { completionSource: options.completionSource } : {}),
		...(options.showWelcome ? { showWelcome: true } : {}),
		...(options.history ? { history: options.history } : {}),
	});
	return { app, input, output, bus };
}

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
		input.emit(Buffer.from("go\r")); await Bun.sleep(10);
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
		send("go\r"); await Bun.sleep(10);
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

test("main view places usage in the header, model on the prompt, and highlights only the selected dense row", async () => {
	const history: SessionMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Start the preview server" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Checking the project and preview response." },
			{ type: "tool_call", id: "a", name: "bash", arguments: { command: "pwd", description: "Inspect project" } },
			{ type: "tool_call", id: "b", name: "bash", arguments: { command: "curl localhost", description: "Check preview response" } }], timestamp: 2 },
	];
	const { app, input, output } = createApp({ history, port: { ...fakePort([]), getUsage: () => ({ contextTokens: 32000, contextWindow: 1000000 }) } });
	await app.start();
	try {
		input.emit(Buffer.from("\t"));
		for (const [columns, rows] of [[120, 32], [80, 24], [40, 12]]) {
			output.columns = columns!; output.rows = rows!;
			const frame = app.composeFrameForTest();
			const lines = frameToText(frame).split("\n");
			const selected = lines.findIndex((line) => line.includes("Check preview response"));
			const other = lines.findIndex((line) => line.includes("Inspect project"));
			expect(selected).toBeGreaterThan(other);
			expect(frame.cells[selected]![10]!.background).toEqual({ kind: "rgb", r: 28, g: 28, b: 28 });
			expect(frame.cells[other]![10]!.background).toEqual({ kind: "rgb", r: 20, g: 20, b: 20 });
			expect(lines[selected]).toContain("│");
			expect(lines.find((line) => line.includes("faux/faux-1"))).toMatch(/╰.*faux\/faux-1.*╯/);
			if (rows! >= 24) {
				expect(lines[1]).toContain("~/proj");
				expect(lines[1]).toContain("32K / 1.0M");
			}
		}
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

test("selected historical tool previews and opens details without submitting the draft", async () => {
	const events: SessionEvent[] = ["older", "newer"].flatMap((id) => [
		{ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts`, start_line: 10 }, timestamp: 1 },
		{ type: "tool_execution_end", toolCallId: id, toolName: "read", content: JSON.stringify({ content: Array.from({ length: 16 }, (_, i) => `${id}_${i + 10}`).join("\n") }), isError: false, timestamp: 2 },
	]);
	const { app, input, bus } = createApp({ port: fakePort(events) });
	const send = (text: string) => input.emit(Buffer.from(text));
	const view = () => frameToText(app.composeFrameForTest());
	await app.start();
	try {
		send("go\r");
		await Bun.sleep(10);
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
		send("go\r"); await Bun.sleep(10);
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
		input.emit(Buffer.from("\r")); await Bun.sleep(10);
		frame = app.composeFrameForTest();
		expect(frameToText(frame)).not.toContain("forge-agent");
		expect(frame.cursor!.y).toBeGreaterThanOrEqual(8);
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
		input.emit(Buffer.from("go\r")); await Bun.sleep(10);
		input.emit(Buffer.from("\t\r"));
		expect(frameToText(app.composeFrameForTest())).toContain("EDIT_NOT_FOUND: missing fragment");
	} finally { await app.stop(); }
});

test("replayed read retains its name, grouping and numbered details without a result toolName", async () => {
	const { app, input } = createApp({ history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "tool_call", id: "old-read", name: "read", arguments: { path: "file.txt", start_line: 12 } }] },
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

test("question subinput Escape leaves text before parking and browsing cannot answer it", async () => {
	const { app, input, bus } = createApp();
	const send = (text: string) => input.emit(Buffer.from(text));
	await app.start();
	try {
		bus.push(request("free", "question", { prompt: "Choose a name", allowFreeText: true }));
		await Bun.sleep(10);
		send("draft answer\x1b"); await Bun.sleep(35);
		expect(frameToText(app.composeFrameForTest())).not.toContain("parked");
		send("\x1b"); await Bun.sleep(35);
		expect(frameToText(app.composeFrameForTest())).toContain("parked");
		send("\x1b[200~ignore\x1b[201~\x1b"); await Bun.sleep(35);
		expect(bus.responses).toHaveLength(0);
		send("i");
		expect(frameToText(app.composeFrameForTest())).toContain("draft answer");
		expect(frameToText(app.composeFrameForTest())).not.toContain("parked");
	} finally { await app.stop(); }
});

test("dragging transcript body copies displayed text without folding or submitting", async () => {
	const { app, input, output } = createApp({ port: fakePort([
		{ type: "message_end", timestamp: 1, message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "COPY_THIS_TEXT" }] } },
	]) });
	await app.start();
	try {
		input.emit(Buffer.from("go\r")); await Bun.sleep(10);
		const y = frameToText(app.composeFrameForTest()).split("\n").findIndex((line) => line.includes("COPY_THIS_TEXT")) + 1;
		input.emit(Buffer.from(`\x1b[<0;6;${y}M\x1b[<32;9;${y}M\x1b[<0;9;${y}m`));
		await Bun.sleep(0);
		expect(output.text).toContain(`\x1b]52;c;${Buffer.from("COPY").toString("base64")}\x07`);
		expect(frameToText(app.composeFrameForTest())).toContain("COPY_THIS_TEXT");
		expect(frameToText(app.composeFrameForTest())).toContain("Copy requested");
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
		await Bun.sleep(0);
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

test("parking a request from the composer shows the keyboard-selected history entry", async () => {
	const { app, input, bus } = createApp({ history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "older message" }] },
		{ role: "assistant", timestamp: 2, content: [{ type: "text", text: "newer message" }] },
	] });
	await app.start();
	try {
		bus.push(request("permission", "permission", { toolCall: { type: "tool_call", id: "call", name: "bash", arguments: { command: "pwd" } } }));
		await Bun.sleep(10);
		input.emit(Buffer.from("\x1b")); await Bun.sleep(35);
		input.emit(Buffer.from("k"));
		expect(frameToText(app.composeFrameForTest())).toContain("> older message");
		expect(bus.responses).toHaveLength(0);
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
		async *runTurn() {
			yield { type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "long-running-command" }, block: outputBlock(60, "streaming"), timestamp: 1 };
			await gate;
			yield { type: "tool_execution_end", toolCallId: "live", toolName: "bash", content: "complete", isError: false, block: outputBlock(100, "complete"), timestamp: 2 };
		},
	} });
	const send = (text: string) => input.emit(Buffer.from(text));
	const view = () => frameToText(app.composeFrameForTest());
	await app.start();
	try {
		send("go\r"); await Bun.sleep(10);
		send("draft\t\r");
		expect(view()).toContain("STREAM_LINE_59");
		send("k".repeat(35));
		const first = view().match(/STREAM_LINE_\d+/)?.[0];
		advance!(); await Bun.sleep(10);
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
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Hello back"));
	const text = frameToText(app.composeFrameForTest());
	expect(text).toContain("❯ hi"); // user band from the event stream
	expect(text).toContain("Worked for 2.1s"); // complete execution notice
	await app.stop();
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
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Run ls"));
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

test("mouse wheel scrolls transcript without editing the draft", async () => {
	const { app, input, output } = createApp({ port: fakePort([
		{ type: "message_end", timestamp: 1, message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: Array.from({ length: 50 }, (_, i) => `wheel-row-${i}`).join("\n") }] } },
	]) });
	await app.start();
	try {
		input.emit(Buffer.from("go\r"));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("wheel-row-49"));
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
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Read 1 file"));
		await Bun.sleep(5);
		expect(frameToText(app.composeFrameForTest())).not.toContain(result);
		input.emit(Buffer.from("\tlje"));
		expect(frameToText(app.composeFrameForTest())).toContain(result);
		input.emit(Buffer.from("e"));
		expect(frameToText(app.composeFrameForTest())).not.toContain(result);
	} finally { await app.stop(); }
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

test("a permission card replaces the composer and only answers on an explicit action", async () => {
	const bus = new FakeBus();
	const { app, input } = createApp({ bus });
	await app.start();
	bus.push(request("r-1", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "ls" } } }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"));
	const withCard = frameToText(app.composeFrameForTest());
	expect(withCard).toContain("Yes, proceed");
	expect(withCard).not.toContain("╭"); // composer is not painted in the same slot
	expect(bus.responses).toEqual([]);
	input.emit(Buffer.from("\r")); // Enter chooses the focused allow_once
	await waitFor(() => bus.responses.length === 1);
	expect(bus.responses[0]).toEqual({ type: "response", id: "r-1", result: { decision: "allow_once" } });
	expect(frameToText(app.composeFrameForTest())).toContain("╭"); // composer returns
	await app.stop();
});

test("AC-33: Esc parks a card without calling respond(); Tab resumes it", async () => {
	const bus = new FakeBus();
	const { app, input } = createApp({ bus });
	await app.start();
	bus.push(request("r-park", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "ls" } } }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"));
	input.emit(Buffer.from("\x1b"));
	await new Promise((resolve) => setTimeout(resolve, 30)); // escape delay
	expect(bus.responses).toEqual([]); // park must not answer
	expect(frameToText(app.composeFrameForTest())).toContain("Permission: bash"); // still painted
	expect(frameToText(app.composeFrameForTest())).toContain("permission"); // shortcuts show the return route
	input.emit(Buffer.from("\t"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("esc"));
	input.emit(Buffer.from("2")); // digit chooses deny
	await waitFor(() => bus.responses.length === 1);
	expect(bus.responses[0]).toMatchObject({ id: "r-park", result: { decision: "deny" } });
	await app.stop();
});

test("AC-34: parked Esc does not abort the turn", async () => {
	let aborted = 0;
	let release: (() => void) | undefined;
	const port: AppPort = {
		async *runTurn() {
			yield { type: "turn_start", timestamp: 1 };
			await new Promise<void>((resolve) => { release = resolve; });
		},
		abort() {
			aborted++;
			release?.();
		},
	};
	const bus = new FakeBus();
	const { app, input } = createApp({ port, bus });
	await app.start();
	input.emit(Buffer.from("go"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => release !== undefined);
	bus.push(request("r-esc", "question", { prompt: "pick one" }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Question"));
	input.emit(Buffer.from("\x1b"));
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(aborted).toBe(0);
	input.emit(Buffer.from("\x1b")); // parked: still no abort
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(aborted).toBe(0);
	expect(bus.responses).toEqual([]);
	await app.stop();
});

test("a late bus terminal archives the card without a second respond()", async () => {
	const bus = new FakeBus();
	const { app } = createApp({ bus });
	await app.start();
	bus.push(request("r-late", "oauth", { provider: "xai", authorizationUrl: "https://example.test" }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("OAuth: xai"));
	bus.pushTerminal({ status: "cancelled", requestId: "r-late", reason: "aborted" });
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("cancelled"));
	expect(bus.responses).toEqual([]);
	expect(frameToText(app.composeFrameForTest())).toContain("╭");
	await app.stop();
});

test("welcome is painted on an empty transcript when requested", async () => {
	const { app } = createApp({ showWelcome: true });
	await app.start();
	expect(frameToText(app.composeFrameForTest())).toMatch(/[▀▄█]/);
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
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("/help"));
	input.emit(Buffer.from("\r")); // applies, does not submit
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("❯ /help"));
	await app.stop();
});

test("Enter queues while a turn is running; Ctrl+Enter aborts and sends", async () => {
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const port: AppPort = {
		async *runTurn(input: string) {
			calls.push(input);
			yield { type: "turn_start", timestamp: 1 };
			if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
			yield { type: "turn_end", timestamp: 2, stopReason: calls.length === 1 ? "aborted" : "stop" };
		},
		abort() {
			release?.();
		},
	};
	const { app, input } = createApp({ port });
	await app.start();
	input.emit(Buffer.from("first"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => calls.length === 1);
	input.emit(Buffer.from("second"));
	input.emit(Buffer.from("\r")); // queue
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("queued") || frameToText(app.composeFrameForTest()).includes("working"));
	input.emit(Buffer.from("third"));
	input.emit(Buffer.from("\x1b[13;5u")); // ctrl+enter: abort and send third
	await waitFor(() => calls.includes("third"));
	expect(calls[0]).toBe("first");
	expect(calls.at(-1)).toBe("third");
	expect(frameToText(app.composeFrameForTest())).toContain("second");
	await app.stop();
});

test("ADR010: Esc during saving restores queued input and draft without autosending", async () => {
	const calls: string[] = [];
	let release!: () => void;
	const { app, input } = createApp({ port: {
		async *runTurn(value) { calls.push(value); yield { type: "agent_end", timestamp: 1 }; await new Promise<void>((resolve) => { release = resolve; }); },
		abort() {},
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined);
		input.emit(Buffer.from("second\rthird\rdraft"));
		expect(frameToText(app.composeFrameForTest())).toContain("second");
		input.emit(Buffer.from("\x1b"));
		await Bun.sleep(40);
		release();
		await Bun.sleep(5);
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
		async *runTurn(value) {
			calls.push(value);
			yield { type: "agent_end", timestamp: 1 };
			await new Promise<void>((resolve) => { release = resolve; });
			throw new Error("disk failed");
		},
		abort() {},
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined);
		input.emit(Buffer.from("second\rthird\x1b[13;5u"));
		release();
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("disk failed"));
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
		async *runTurn(value) { calls.push(value); if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; }); },
		abort() { release?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined);
		input.emit(Buffer.from("second\r\x1b[A"));
		expect(frameToText(app.composeFrameForTest())).toContain("❯ second");
		input.emit(Buffer.from(" edited\r"));
		release();
		await waitFor(() => calls.length === 2);
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
		async *runTurn(value) {
			calls.push(value);
			if (phase === "stream") yield { type: "message_delta", contentIndex: 0, contentType: "text", delta: "partial", timestamp: 1 };
			else yield { type: "tool_execution_start", toolCallId: "hold", toolName: "hold", args: {}, timestamp: 1 };
			await new Promise<void>((resolve) => { cancel = resolve; });
			cleaning = true;
			await cleanup;
			yield { type: "turn_end", stopReason: "aborted", timestamp: 2 };
		},
		abort() { cancel?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => cancel !== undefined);
		input.emit(Buffer.from("queued\r\x1b"));
		await waitFor(() => cleaning);
		expect(frameToText(app.composeFrameForTest())).toContain("❯ queued");
		input.emit(Buffer.from(" during cleanup\r"));
		finish();
		await waitFor(() => !frameToText(app.composeFrameForTest()).includes("stopping"));
		expect(calls).toEqual(["first"]);
		expect(frameToText(app.composeFrameForTest())).toContain("❯ queued during cleanup");
	} finally { cancel?.(); finish(); await app.stop(); }
});

test("repeated Enter submissions run in FIFO order", async () => {
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const { app, input } = createApp({ port: {
		async *runTurn(value) {
			calls.push(value);
			if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
		},
		abort() { release?.(); },
	} });
	await app.start();
	try {
		input.emit(Buffer.from("first\r"));
		await waitFor(() => release !== undefined);
		input.emit(Buffer.from("second\rthird\r"));
		release?.();
		await waitFor(() => calls.length >= 2);
		await Bun.sleep(5);
		expect(calls).toEqual(["first", "second", "third"]);
	} finally { await app.stop(); }
});

test("stop aborts and waits for the active turn and never starts queued input", async () => {
	const calls: string[] = [];
	let release: (() => void) | undefined;
	let aborted = false;
	let settled = false;
	const { app, input } = createApp({ port: {
		async *runTurn(value) {
			calls.push(value);
			await new Promise<void>((resolve) => { release = resolve; });
			await Bun.sleep(5);
			settled = true;
		},
		abort() { aborted = true; release?.(); },
	} });
	await app.start();
	input.emit(Buffer.from("first\r"));
	await waitFor(() => release !== undefined);
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
		await Bun.sleep(0);
		pending.get("ab")?.(null);
		await Bun.sleep(0);
		pending.get("a")?.({ items: [{ value: "stale", label: "STALE_COMPLETION" }], prefix: "a" });
		await Bun.sleep(0);
		expect(frameToText(app.composeFrameForTest())).not.toContain("STALE_COMPLETION");
		input.emit(Buffer.from("c\r"));
		await Bun.sleep(0);
		pending.get("abc")?.({ items: [{ value: "stale", label: "STALE_COMPLETION" }], prefix: "abc" });
		await Bun.sleep(0);
		expect(frameToText(app.composeFrameForTest())).not.toContain("STALE_COMPLETION");
	} finally { await app.stop(); }
});

test("context display uses the port truth point instead of last response totals", async () => {
	const { app, input } = createApp({ port: {
		...fakePort([{ type: "message_end", timestamp: 1, message: {
			role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1,
			usage: { input: 9_000, output: 999, totalTokens: 9_999, cacheRead: 0, cacheWrite: 0 },
		} }]),
		getUsage: () => ({ contextTokens: 2_000, contextWindow: 128_000, contextEstimated: true }),
	} as AppPort });
	await app.start();
	try {
		input.emit(Buffer.from("go\r"));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("done"));
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("~2K / 128K");
		expect(text).not.toContain("10K");
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
		async *runTurn() {
			yield { type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } };
			yield { type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: first };
			await new Promise<void>((resolve) => { advance = resolve; });
			yield { type: "message_delta", timestamp: 3, contentIndex: 0, contentType: "text", delta: "\nnew-row-a\nnew-row-b" };
		},
		abort() { advance?.(); },
	} });
	await app.start();
	try {
		const header = frameToText(app.composeFrameForTest()).split("\n")[0];
		input.emit(Buffer.from("go\r"));
		await waitFor(() => advance !== undefined);
		input.emit(Buffer.from("\x1b[5~"));
		const before = frameToText(app.composeFrameForTest()).split("\n");
		advance?.();
		await Bun.sleep(5);
		const after = frameToText(app.composeFrameForTest()).split("\n");
		expect(after[1]).toBe(before[1]);
		expect(after[0]).toBe(header);
	} finally { await app.stop(); }
});

test("a rejected card response cannot be archived as an authorization", async () => {
	const { app, input, bus } = createApp();
	bus.acceptResponses = false;
	await app.start();
	try {
		bus.push(request("late", "permission", { toolCall: { type: "tool_call", id: "t", name: "bash", arguments: { command: "ls" } } }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"));
		input.emit(Buffer.from("\r"));
		bus.pushTerminal({ status: "timeout", requestId: "late" });
		await Bun.sleep(0);
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("timed out");
		expect(text).not.toContain("allow_once");
	} finally { await app.stop(); }
});

test("question cards accept a chosen option and free text without using the composer", async () => {
	const { app, input, bus } = createApp();
	await app.start();
	try {
		bus.push(request("choice", "question", { prompt: "Pick", choices: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Question"));
		input.emit(Buffer.from("\t\r"));
		expect(bus.responses[0]?.result).toEqual({ decision: "answer", answers: ["b"] });
		bus.push(request("text", "question", { prompt: "Name", allowFreeText: true }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Name"));
		input.emit(Buffer.from("my answer\t\r"));
		expect(bus.responses[1]?.result).toEqual({ decision: "answer", answers: ["my answer"] });
	} finally { await app.stop(); }
});

test("question multiple selection records only the choices explicitly toggled", async () => {
	const { app, input, bus } = createApp();
	await app.start();
	try {
		bus.push(request("multi", "question", { prompt: "Pick", multiple: true, choices: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Question"));
		input.emit(Buffer.from("\t \t\r"));
		expect(bus.responses[0]?.result).toEqual({ decision: "answer", answers: ["b"] });
	} finally { await app.stop(); }
});

test("permission body can be scrolled without hiding the selected action", async () => {
	const { app, input, bus } = createApp();
	await app.start();
	try {
		bus.push(request("long", "permission", { toolCall: { type: "tool_call", id: "t", name: "write", arguments: { path: "file", content: "line ".repeat(200) + "END_OF_CHANGE" } } }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: write"));
		for (let index = 0; index < 30; index++) input.emit(Buffer.from("\x1b[6~"));
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("END_OF_CHANGE");
		expect(text).toContain("Yes, allow once");
	} finally { await app.stop(); }
});

test("a terminal arriving before its request cannot leave a blocking card", async () => {
	const { app, bus } = createApp();
	await app.start();
	try {
		bus.pushTerminal({ status: "timeout", requestId: "already-done" });
		await Bun.sleep(0);
		bus.push(request("already-done", "question", { prompt: "expired" }));
		await Bun.sleep(0);
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("timed out");
		expect(text).toContain("╭");
		expect(bus.responses).toEqual([]);
	} finally { await app.stop(); }
});

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met in time");
}
