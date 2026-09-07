import { graphemes } from "./width.ts";

/**
 * Structured key events decoded from raw stdin bytes (phase 2.2 B1).
 * No kitty keyboard protocol negotiation; kitty-style CSI-u and xterm
 * modifyOtherKeys forms are still decoded when a terminal sends them.
 */
export type Key =
	| { type: "char"; text: string }
	| { type: "enter" }
	| { type: "newline" }
	| { type: "backspace" }
	| { type: "tab" }
	| { type: "shiftTab" }
	| { type: "escape" }
	| { type: "ctrl"; key: string }
	| { type: "ctrlEnter" }
	| { type: "arrow"; direction: "up" | "down" | "left" | "right"; ctrl: boolean }
	| { type: "home" }
	| { type: "end" }
	| { type: "delete" }
	| { type: "pageUp" }
	| { type: "pageDown" }
	| { type: "mouse"; action: "up" | "down" | "click" | "release" | "drag"; x: number; y: number }
	| { type: "paste"; text: string }
	| { type: "unknown"; raw: string };

const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const SEQUENCES: readonly (readonly [string, Key])[] = [
	["\x1b[13;2u", { type: "newline" }],
	["\x1b[27;2;13~", { type: "newline" }],
	["\x1b\r", { type: "newline" }],
	["\x1b[A", { type: "arrow", direction: "up", ctrl: false }],
	["\x1b[B", { type: "arrow", direction: "down", ctrl: false }],
	["\x1b[C", { type: "arrow", direction: "right", ctrl: false }],
	["\x1b[D", { type: "arrow", direction: "left", ctrl: false }],
	["\x1bOA", { type: "arrow", direction: "up", ctrl: false }],
	["\x1bOB", { type: "arrow", direction: "down", ctrl: false }],
	["\x1bOC", { type: "arrow", direction: "right", ctrl: false }],
	["\x1bOD", { type: "arrow", direction: "left", ctrl: false }],
	["\x1b[1;5A", { type: "arrow", direction: "up", ctrl: true }],
	["\x1b[1;5B", { type: "arrow", direction: "down", ctrl: true }],
	["\x1b[1;5C", { type: "arrow", direction: "right", ctrl: true }],
	["\x1b[1;5D", { type: "arrow", direction: "left", ctrl: true }],
	["\x1b[Z", { type: "shiftTab" }],
	["\x1b[H", { type: "home" }],
	["\x1b[F", { type: "end" }],
	["\x1b[1~", { type: "home" }],
	["\x1b[4~", { type: "end" }],
	["\x1b[3~", { type: "delete" }],
	["\x1b[5~", { type: "pageUp" }],
	["\x1b[6~", { type: "pageDown" }],
	["\x1b[13;5u", { type: "ctrlEnter" }],
	["\x1b[27;5;13~", { type: "ctrlEnter" }],
];

export class KeyDecoder {
	private buffer = "";
	private pasting = false;
	private pasteBuffer = "";
	private readonly decoder = new TextDecoder("utf-8", { fatal: false });

	push(data: Buffer | string): Key[] {
		if (typeof data === "string") {
			this.buffer += data;
			return this.drain(false);
		}
		const keys: Key[] = [];
		for (let offset = 0; offset < data.length;) {
			// X10 has three binary payload bytes; decoding them as UTF-8 loses large coordinates.
			if (!this.pasting && this.buffer.startsWith("\x1b[M") && this.buffer.length < 6) {
				this.buffer += String.fromCharCode(data[offset++]!);
			} else {
				const prefix = this.buffer === "\x1b" || this.buffer === "\x1b[" || data[offset] === 27;
				const escape = data.indexOf(27, offset + 1);
				const end = prefix ? offset + 1 : escape === -1 ? data.length : escape;
				this.buffer += this.decoder.decode(data.subarray(offset, end), { stream: true });
				offset = end;
			}
			keys.push(...this.drain(false));
		}
		return keys;
	}

	/** True while undecoded bytes wait for the ambiguity window (lone ESC, partial sequence, paste). */
	get pending(): boolean {
		return !this.pasting && this.buffer.length > 0;
	}

	/** Resolve a pending lone ESC (or malformed tail) after the ambiguity window. */
	flush(): Key[] {
		if (this.pasting) return [];
		this.buffer += this.decoder.decode();
		return this.drain(true);
	}

	private drain(final: boolean): Key[] {
		const keys: Key[] = [];
		while (this.buffer.length > 0) {
			if (this.pasting) {
				const end = this.buffer.indexOf(PASTE_END);
				if (end === -1) {
					let suffixLength = Math.min(this.buffer.length, PASTE_END.length - 1);
					while (suffixLength > 0 && !PASTE_END.startsWith(this.buffer.slice(-suffixLength))) suffixLength--;
					this.pasteBuffer += this.buffer.slice(0, this.buffer.length - suffixLength);
					this.buffer = suffixLength > 0 ? this.buffer.slice(-suffixLength) : "";
					break;
				}
				this.pasteBuffer += this.buffer.slice(0, end);
				this.buffer = this.buffer.slice(end + PASTE_END.length);
				this.pasting = false;
				keys.push({ type: "paste", text: this.pasteBuffer });
				this.pasteBuffer = "";
				continue;
			}
			if (this.buffer.startsWith(PASTE_BEGIN)) {
				this.buffer = this.buffer.slice(PASTE_BEGIN.length);
				this.pasting = true;
				continue;
			}
			if (!final && PASTE_BEGIN.startsWith(this.buffer)) break;
			if (this.buffer[0] === "\x1b") {
				if (this.buffer.startsWith("\x1b[<") || this.buffer.startsWith("\x1b[M")) {
					const sgr = this.buffer.startsWith("\x1b[<");
					const report = sgr ? /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer) : null;
					const length = sgr ? report?.[0].length : this.buffer.length >= 6 ? 6 : undefined;
					if (length === undefined) {
						if (!final && (!sgr || /^\x1b\[<[\d;]*$/.test(this.buffer))) break;
						keys.push({ type: "unknown", raw: this.buffer });
						this.buffer = "";
						break;
					}
					const button = sgr ? Number(report![1]) : this.buffer.charCodeAt(3) - 32;
					const x = sgr ? Number(report![2]) - 1 : this.buffer.charCodeAt(4) - 33;
					const y = sgr ? Number(report![3]) - 1 : this.buffer.charCodeAt(5) - 33;
					const base = button & ~28;
					if (x >= 0 && y >= 0) {
						if ((sgr && report![4] === "m" && base === 0) || (!sgr && base === 3)) keys.push({ type: "mouse", action: "release", x, y });
						else if (base === 64 || base === 65) keys.push({ type: "mouse", action: base === 64 ? "up" : "down", x, y });
						else if (base === 32) keys.push({ type: "mouse", action: "drag", x, y });
						else if (button === 0) keys.push({ type: "mouse", action: "click", x, y });
					}
					this.buffer = this.buffer.slice(length);
					continue;
				}
				if (this.buffer === "\x1b") {
					if (!final) break;
					keys.push({ type: "escape" });
					this.buffer = "";
					break;
				}
				const match = matchSequence(this.buffer);
				if (match === "prefix") {
					if (!final) break;
					keys.push({ type: "unknown", raw: this.buffer });
					this.buffer = "";
					break;
				}
				if (match) {
					keys.push(match.key);
					this.buffer = this.buffer.slice(match.sequence.length);
					continue;
				}
				keys.push({ type: "escape" });
				this.buffer = this.buffer.slice(1);
				continue;
			}
			const codepoint = this.buffer.codePointAt(0)!;
			if (codepoint === 0x0d || codepoint === 0x0a) {
				keys.push({ type: "enter" });
				this.buffer = this.buffer.slice(1);
				continue;
			}
			if (codepoint === 0x09) {
				keys.push({ type: "tab" });
				this.buffer = this.buffer.slice(1);
				continue;
			}
			if (codepoint === 0x7f || codepoint === 0x08) {
				keys.push({ type: "backspace" });
				this.buffer = this.buffer.slice(1);
				continue;
			}
			if (codepoint >= 0x01 && codepoint <= 0x1a) {
				keys.push({ type: "ctrl", key: String.fromCharCode(0x60 + codepoint) });
				this.buffer = this.buffer.slice(1);
				continue;
			}
			if (codepoint < 0x20) {
				keys.push({ type: "unknown", raw: this.buffer[0]! });
				this.buffer = this.buffer.slice(1);
				continue;
			}
			const grapheme = graphemes(this.buffer)[0]!;
			keys.push({ type: "char", text: grapheme });
			this.buffer = this.buffer.slice(grapheme.length);
		}
		return keys;
	}
}

function matchSequence(buffer: string): { sequence: string; key: Key } | "prefix" | null {
	let isPrefix = false;
	for (const [sequence, key] of SEQUENCES) {
		if (buffer.startsWith(sequence)) return { sequence, key };
		if (sequence.startsWith(buffer)) isPrefix = true;
	}
	return isPrefix ? "prefix" : null;
}

export function isCtrlC(key: Key): boolean {
	return key.type === "ctrl" && key.key === "c";
}
