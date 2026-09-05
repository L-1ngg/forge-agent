import { defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import type { Theme } from "./theme.ts";
import { truncateToWidth } from "./width.ts";

export interface WelcomeInput {
	cwd: string;
	homeDir: string;
	model?: string | undefined;
}

/** Idle empty-transcript page. Does not block the composer. */
export function paintWelcome(frame: TerminalFrame, top: number, height: number, input: WelcomeInput, theme: Theme): void {
	if (height <= 0) return;
	const cwd = input.cwd.startsWith(input.homeDir) ? `~${input.cwd.slice(input.homeDir.length)}` : input.cwd;
	const lines = [
		"Forge Agent",
		"Type a message to start. / for commands, @ for files.",
		input.model ? `model ${input.model} · ${cwd}` : cwd,
	];
	const start = top + Math.max(0, Math.floor((height - lines.length) / 3));
	for (const [index, line] of lines.entries()) {
		const y = start + index;
		if (y < top || y >= top + height || y >= frame.rows) continue;
		const slot = index === 0 ? "status" : "muted";
		writeText(frame, 2, y, truncateToWidth(line, Math.max(1, frame.columns - 4)), { ...defaultStyle(), foreground: theme.color(slot), attributes: { ...defaultStyle().attributes, bold: index === 0 } });
	}
}
