import { expect, test } from "bun:test";
import { KeyDecoder, isCtrlC, type Key } from "../src/index.ts";

function decode(input: string): Key[] {
	const decoder = new KeyDecoder();
	const keys = decoder.push(input);
	keys.push(...decoder.flush());
	return keys;
}

test("printable text decodes per grapheme", () => {
	expect(decode("a")).toEqual([{ type: "char", text: "a" }]);
	expect(decode("你好")).toEqual([
		{ type: "char", text: "你" },
		{ type: "char", text: "好" },
	]);
	expect(decode("🇨🇳!")).toEqual([
		{ type: "char", text: "🇨🇳" },
		{ type: "char", text: "!" },
	]);
});

test("control keys decode to structured events", () => {
	expect(decode("\r")).toEqual([{ type: "enter" }]);
	expect(decode("\t")).toEqual([{ type: "tab" }]);
	expect(decode("\x7f")).toEqual([{ type: "backspace" }]);
	expect(decode("\x08")).toEqual([{ type: "backspace" }]);
	const [ctrlC] = decode("\x03");
	expect(ctrlC).toEqual({ type: "ctrl", key: "c" });
	expect(isCtrlC(ctrlC!)).toBe(true);
});

test("arrows decode in CSI, SS3 and ctrl-modified forms", () => {
	expect(decode("\x1b[A")).toEqual([{ type: "arrow", direction: "up", ctrl: false }]);
	expect(decode("\x1bOD")).toEqual([{ type: "arrow", direction: "left", ctrl: false }]);
	expect(decode("\x1b[1;5C")).toEqual([{ type: "arrow", direction: "right", ctrl: true }]);
});

test("navigation keys decode", () => {
	expect(decode("\x1b[Z")).toEqual([{ type: "shiftTab" }]);
	expect(decode("\x1b[H")).toEqual([{ type: "home" }]);
	expect(decode("\x1b[F")).toEqual([{ type: "end" }]);
	expect(decode("\x1b[3~")).toEqual([{ type: "delete" }]);
	expect(decode("\x1b[5~")).toEqual([{ type: "pageUp" }]);
	expect(decode("\x1b[6~")).toEqual([{ type: "pageDown" }]);
});

test("ctrl+enter decodes from kitty-style and modifyOtherKeys forms", () => {
	expect(decode("\x1b[13;5u")).toEqual([{ type: "ctrlEnter" }]);
	expect(decode("\x1b[27;5;13~")).toEqual([{ type: "ctrlEnter" }]);
});

test("a lone ESC waits for the ambiguity window, then resolves to escape", () => {
	const decoder = new KeyDecoder();
	expect(decoder.push("\x1b")).toEqual([]);
	expect(decoder.pending).toBe(true);
	expect(decoder.flush()).toEqual([{ type: "escape" }]);
	expect(decoder.pending).toBe(false);
});

test("escape sequences split across chunks still decode", () => {
	const decoder = new KeyDecoder();
	expect(decoder.push("\x1b[")).toEqual([]);
	expect(decoder.push("A")).toEqual([{ type: "arrow", direction: "up", ctrl: false }]);
});

test("ESC followed by plain text is escape plus chars", () => {
	expect(decode("\x1bx")).toEqual([{ type: "escape" }, { type: "char", text: "x" }]);
});

test("bracketed paste keeps newlines out of enter", () => {
	expect(decode("\x1b[200~line1\nline2\r\nline3\x1b[201~")).toEqual([{ type: "paste", text: "line1\nline2\r\nline3" }]);
});

test("ESC followed by bytes that cannot form a sequence decodes liberally", () => {
	expect(decode("\x1b[9")).toEqual([{ type: "escape" }, { type: "char", text: "[" }, { type: "char", text: "9" }]);
});

test("an incomplete but plausible sequence flushes as unknown", () => {
	const decoder = new KeyDecoder();
	expect(decoder.push("\x1b[1;5")).toEqual([]); // prefix of ctrl+arrow: waits
	expect(decoder.flush()).toEqual([{ type: "unknown", raw: "\x1b[1;5" }]);
});

test("split UTF-8 across buffers decodes once", () => {
	const decoder = new KeyDecoder();
	const bytes = Buffer.from("你", "utf-8"); // 3 bytes
	expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
	expect(decoder.push(bytes.subarray(1))).toEqual([{ type: "char", text: "你" }]);
});

test("bracketed paste survives every byte split including both delimiters", () => {
	const raw = Buffer.from("\x1b[200~one\n你好\x1b[201~");
	for (let split = 1; split < raw.length; split++) {
		const decoder = new KeyDecoder();
		expect([...decoder.push(raw.subarray(0, split)), ...decoder.push(raw.subarray(split))]).toEqual([{ type: "paste", text: "one\n你好" }]);
	}
});

test("escape timeout does not discard a slow bracketed paste", () => {
	const decoder = new KeyDecoder();
	expect(decoder.push("\x1b[200~one")).toEqual([]);
	expect(decoder.flush()).toEqual([]);
	expect(decoder.push("\ntwo\x1b[201~")).toEqual([{ type: "paste", text: "one\ntwo" }]);
});
