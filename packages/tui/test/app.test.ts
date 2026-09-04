import { expect, test } from "bun:test";
import { block, request, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type ResponseEnvelope, type SessionEvent } from "@myh/protocol";
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
		return true;
	}

	async *requests(): AsyncIterable<RequestEnvelopeUnion> {
		let index = 0;
		for (;;) {
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
		for (;;) {
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

function createApp(options: { port?: AppPort; bus?: FakeBus; completionSource?: AppCompletionSource; showWelcome?: boolean } = {}) {
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
		...(options.completionSource ? { completionSource: options.completionSource } : {}),
		...(options.showWelcome ? { showWelcome: true } : {}),
	});
	return { app, input, output, bus };
}

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
		{ type: "turn_start", timestamp: 900 },
		{ type: "message_start", timestamp: 1000, message: userMessage },
		{ type: "message_end", timestamp: 1001, message: userMessage },
		{ type: "message_start", timestamp: 2000, message: { role: "assistant", content: [], timestamp: 2000 } },
		{ type: "message_delta", timestamp: 2001, contentIndex: 0, contentType: "text", delta: "Hello" },
		{ type: "message_delta", timestamp: 2002, contentIndex: 0, contentType: "text", delta: " back" },
		{ type: "message_end", timestamp: 2003, message: assistantDone },
		{ type: "turn_end", timestamp: 3000, stopReason: "stop" },
	]);
	const { app, input } = createApp({ port });
	await app.start();
	input.emit(Buffer.from("hi"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Hello back"));
	const text = frameToText(app.composeFrameForTest());
	expect(text).toContain("❯ hi"); // user band from the event stream
	expect(text).toContain("Worked for 2.1s"); // turn notice from the projector
	await app.stop();
});

test("ctrl+o folds the latest foldable entry", async () => {
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
	expect(frameToText(app.composeFrameForTest())).toContain("… +3 lines"); // truncated by default
	input.emit(Buffer.from([0x0f])); // ctrl+o
	expect(frameToText(app.composeFrameForTest())).toContain("Run ls");
	expect(frameToText(app.composeFrameForTest())).not.toContain("… +3 lines"); // collapsed to header
	await app.stop();
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
	const plan = computeScreenLayout({ columns: 80, rows: 24, interactiveLines: 2, hasStatus: true });
	const transcriptLines = text.split("\n").slice(1, 1 + plan.transcript.height);
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
	const port: AppPort = {
		async *runTurn() {
			yield { type: "turn_start", timestamp: 1 };
			await new Promise<void>(() => {}); // hang until abort
		},
		abort() {
			aborted++;
		},
	};
	const bus = new FakeBus();
	const { app, input } = createApp({ port, bus });
	await app.start();
	input.emit(Buffer.from("go"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("working") || true);
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
	expect(frameToText(app.composeFrameForTest())).toContain("Type a message to start");
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
	await app.stop();
});

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met in time");
}
