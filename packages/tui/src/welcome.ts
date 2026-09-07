import { defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import type { Theme } from "./theme.ts";

export interface WelcomeInput {
	cwd: string;
	homeDir: string;
	model?: string | undefined;
}

// Seven pixel rows packed into four terminal rows, including lowercase descenders.
const glyphs: Record<string, readonly string[]> = {
	f: ["00110", "01000", "11110", "01000", "01000", "01000", "01000"],
	o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
	r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
	g: ["00000", "01111", "10001", "10001", "01111", "00001", "01110"],
	e: ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
	"-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
	a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
	n: ["00000", "00000", "10110", "11001", "10001", "10001", "10001"],
	t: ["01000", "01000", "11110", "01000", "01000", "01001", "00110"],
};
const pixels = Array.from({ length: 8 }, (_, row) => [..."forge-agent"].map((letter) => glyphs[letter]![row] ?? "00000").join("0"));
const logo = Array.from({ length: 4 }, (_, row) => [...pixels[row * 2]!].map((top, column) => {
	const bottom = pixels[row * 2 + 1]![column];
	return top === "1" ? bottom === "1" ? "█" : "▀" : bottom === "1" ? "▄" : " ";
}).join(""));

export function welcomeHeight(columns: number, available: number): number {
	return columns >= logo[0]!.length + 4 && available >= 10 ? 4 : 1;
}

/** Paint only the brand; App places the real composer directly beneath it. */
export function paintWelcome(frame: TerminalFrame, top: number, height: number, input: WelcomeInput, theme: Theme): void {
	if (height <= 0) return;
	const lines = height >= 4 && frame.columns >= logo[0]!.length + 4 ? logo : ["forge-agent"];
	for (const [index, line] of lines.entries()) {
		const y = top + index;
		if (y < top || y >= top + height || y >= frame.rows) continue;
		writeText(frame, Math.max(0, Math.floor((frame.columns - line.length) / 2)), y, line, { ...defaultStyle(), foreground: theme.color(index === 3 ? "muted" : "status"), attributes: { ...defaultStyle().attributes, bold: true } });
	}
}
