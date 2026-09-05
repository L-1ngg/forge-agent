import { expect, test } from "bun:test";
import { ENTER_ALT_SCREEN, HIDE_CURSOR, LEAVE_ALT_SCREEN, cursorPosition } from "../src/ansi.ts";
import { Host, type HostInput, type HostOutput } from "../src/host.ts";
import { createFrame, setCursor, writeText, type TerminalFrame } from "../src/index.ts";
import type { Key } from "../src/keys.ts";

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
	failOn: string | undefined;
	write(text: string): void {
		if (this.failOn && text.includes(this.failOn)) throw new Error("injected write failure");
		this.chunks.push(text);
	}
	get text(): string {
		return this.chunks.join("");
	}
	count(needle: string): number {
		return this.chunks.filter((chunk) => chunk.includes(needle)).length;
	}
}

function createHost(options: { onKey?: (key: Key) => void; onResize?: (columns: number, rows: number) => void } = {}) {
	const input = new FakeInput();
	const output = new FakeOutput();
	const host = new Host({ stdin: input, stdout: output, trapSignals: false, escapeDelayMs: 5, ...options });
	return { host, input, output };
}

test("start enters alt-screen and raw mode; stop restores exactly once", () => {
	const { host, input, output } = createHost();
	host.start();
	expect(output.text).toContain(ENTER_ALT_SCREEN);
	expect(input.raw).toBe(true);
	expect(output.text).toContain("\x1b[?2004h");
	host.stop();
	host.stop();
	expect(input.raw).toBe(false);
	expect(output.count(LEAVE_ALT_SCREEN)).toBe(1);
	expect(output.text).toContain("\x1b[?2004l");
});

test("paint before start throws without touching the terminal", () => {
	const { host, output } = createHost();
	expect(() => host.paint(createFrame(4, 1))).toThrow("host is not started");
	expect(output.text).toBe("");
});

test("repaint of an identical frame emits no cell output", () => {
	const { host, output } = createHost();
	host.start();
	const frame = createFrame(8, 2);
	writeText(frame, 0, 0, "stable");
	host.paint(frame);
	const chunksAfterFirstPaint = output.chunks.length;
	host.paint(frame);
	const repaint = output.chunks.slice(chunksAfterFirstPaint).join("");
	expect(repaint).toBe(HIDE_CURSOR); // cursor bookkeeping only
	host.stop();
});

test("a one-cell change paints exactly that cell", () => {
	const { host, output } = createHost();
	host.start();
	const frame = createFrame(10, 2);
	writeText(frame, 0, 0, "keep");
	host.paint(frame);
	const next = createFrame(10, 2);
	writeText(next, 0, 0, "keep");
	writeText(next, 5, 1, "X");
	host.paint(next);
	const chunk = output.chunks.at(-1)!;
	expect(chunk).toContain(cursorPosition(5, 1));
	expect(chunk).toContain("X");
	expect(chunk).not.toContain("keep");
	host.stop();
});

test("crash path: a throwing paint still restores the terminal", () => {
	const { host, input, output } = createHost();
	host.start();
	const frame: TerminalFrame = createFrame(6, 1);
	writeText(frame, 0, 0, "kaboom");
	output.failOn = "kaboom";
	expect(() => host.paint(frame)).toThrow("injected write failure");
	expect(input.raw).toBe(false);
	expect(output.chunks.at(-1)).toContain(LEAVE_ALT_SCREEN);
	expect(host.isStarted).toBe(false);
	host.stop();
	expect(output.count(LEAVE_ALT_SCREEN)).toBe(1);
});

test("resize clears the diff baseline and reports the new size", () => {
	const sizes: string[] = [];
	const { host, output } = createHost({ onResize: (columns, rows) => sizes.push(`${columns}x${rows}`) });
	host.start();
	host.paint(createFrame(80, 24));
	output.columns = 40;
	output.rows = 12;
	process.emit("SIGWINCH");
	expect(sizes).toEqual(["40x12"]);
	const chunksAfterResize = output.chunks.length;
	host.paint(createFrame(40, 12)); // size change forces a full repaint
	expect(output.chunks.slice(chunksAfterResize).join("")).toContain(cursorPosition(0, 11));
	host.stop();
});

test("keys flow through the decoder; a lone ESC resolves after the delay", async () => {
	const keys: Key[] = [];
	const { host, input } = createHost({ onKey: (key) => keys.push(key) });
	host.start();
	input.emit(Buffer.from("a"));
	input.emit(Buffer.from("\x1b"));
	expect(keys).toEqual([{ type: "char", text: "a" }]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(keys).toEqual([{ type: "char", text: "a" }, { type: "escape" }]);
	host.stop();
});

test("cursor frame state is painted", () => {
	const { host, output } = createHost();
	host.start();
	const frame = createFrame(4, 1);
	setCursor(frame, 1, 0, "underline");
	host.paint(frame);
	expect(output.text).toContain("\x1b[4 q");
	host.stop();
});
