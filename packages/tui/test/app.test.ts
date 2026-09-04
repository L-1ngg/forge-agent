import { expect, test } from "bun:test";
import { request, type RequestEnvelopeUnion, type ResponseEnvelope, type SessionEvent } from "@myh/protocol";
import { App, computeScreenLayout, frameToText, type AppPort, type AppRequestBus } from "../src/index.ts";
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
	private notify: (() => void) | undefined;

	push(envelope: RequestEnvelopeUnion): void {
		this.envelopes.push(envelope);
		this.notify?.();
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
}

function fakePort(events: SessionEvent[]): AppPort {
	return {
		async *runTurn() {
			for (const event of events) yield event;
		},
	};
}

function createApp(options: { port?: AppPort; bus?: FakeBus } = {}) {
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
	const port = fakePort([
		{ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } },
		{ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "Hello" },
		{ type: "message_delta", timestamp: 3, contentIndex: 0, contentType: "text", delta: " back" },
		{ type: "turn_end", timestamp: 4, stopReason: "stop" },
	]);
	const { app, input } = createApp({ port });
	await app.start();
	input.emit(Buffer.from("hi"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Hello back"));
	expect(frameToText(app.composeFrameForTest())).toContain("❯ hi");
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
	const plan = computeScreenLayout({ columns: 80, rows: 24, composerLines: 2, hasStatus: true });
	const transcriptLines = text.split("\n").slice(1, 1 + plan.transcript.height);
	expect(transcriptLines.every((line) => line.trim() === "")).toBe(true);
	await app.stop();
});

test("permission request gets the conservative deny while no request UI exists", async () => {
	const bus = new FakeBus();
	const { app } = createApp({ bus });
	await app.start();
	bus.push(request("r-1", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "ls" } } }));
	await waitFor(() => bus.responses.length === 1);
	expect(bus.responses[0]).toEqual({
		type: "response",
		id: "r-1",
		result: { decision: "deny", reason: "interactive request UI is being rebuilt (phase 2.2 B0-B3)" },
	});
	await app.stop();
});

test("question request gets the conservative cancel while no request UI exists", async () => {
	const bus = new FakeBus();
	const { app } = createApp({ bus });
	await app.start();
	bus.push(request("r-2", "question", { prompt: "pick one" }));
	await waitFor(() => bus.responses.length === 1);
	expect(bus.responses[0]).toEqual({ type: "response", id: "r-2", result: { decision: "cancel" } });
	await app.stop();
});

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met in time");
}
