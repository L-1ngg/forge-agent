import { expect, test } from "bun:test";
import { KeyDecoder, isCtrlC, type Key } from "../src/index.ts";

function decode(input: string): Key[] {
	const decoder = new KeyDecoder();
	const keys = decoder.push(input);
	keys.push(...decoder.flush());
	return keys;
}

test("mouse reports survive every byte split and do not become text or Escape", () => {
	for (const report of ["\x1b[<64;10;5M", "\x1b[M" + String.fromCharCode(96, 42, 37)]) {
		for (let split = 1; split < report.length; split++) {
			const decoder = new KeyDecoder();
			expect([...decoder.push(report.slice(0, split)), ...decoder.push(report.slice(split)), ...decoder.flush()]).toEqual([
				{ type: "mouse", action: "up", x: 9, y: 4 },
			]);
		}
	}
	expect(decode("\x1b[<65;300;40M\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<32;10;5M\x1b[<2;10;5Mx")).toEqual([
		{ type: "mouse", action: "down", x: 299, y: 39 },
		{ type: "mouse", action: "click", x: 9, y: 4 },
		{ type: "mouse", action: "release", x: 9, y: 4 },
		{ type: "mouse", action: "drag", x: 9, y: 4 },
		{ type: "char", text: "x" },
	]);
	expect(decode("\x1b[<64;10;")).toEqual([{ type: "unknown", raw: "\x1b[<64;10;" }]);
});

test("legacy mouse coordinates remain raw bytes beside UTF-8 text at every split", () => {
	for (const coordinate of [94, 95, 119, 190, 222]) {
		const raw = Buffer.concat([Buffer.from("你好"), Buffer.from([27, 91, 77, 32, coordinate + 33, coordinate + 33]), Buffer.from("完成")]);
		const expected: Key[] = [
			{ type: "char", text: "你" }, { type: "char", text: "好" },
			{ type: "mouse", action: "click", x: coordinate, y: coordinate },
			{ type: "char", text: "完" }, { type: "char", text: "成" },
		];
		for (let split = 1; split < raw.length; split++) {
			const decoder = new KeyDecoder();
			expect([...decoder.push(raw.subarray(0, split)), ...decoder.push(raw.subarray(split)), ...decoder.flush()]).toEqual(expected);
		}
		const decoder = new KeyDecoder();
		expect([...raw].flatMap((byte) => decoder.push(Buffer.from([byte])))).toEqual(expected);
	}
});

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
