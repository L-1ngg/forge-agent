import { defaultStyle, writeText, type CellStyle, type TerminalFrame } from "./frame.ts";
import { truncateToWidth, visibleWidth } from "./width.ts";
import type { Theme } from "./theme.ts";

/** One-row header: cwd on the left, context summary on the right. */
export function paintHeader(frame: TerminalFrame, y: number, input: { cwd: string; homeDir: string; contextLabel?: string }, theme: Theme): void {
	if (y >= frame.rows) return;
	const cwd = input.cwd.startsWith(input.homeDir) ? `~${input.cwd.slice(input.homeDir.length)}` : input.cwd;
	const left: CellStyle = { ...defaultStyle(), foreground: theme.color("muted") };
	const right: CellStyle = { ...defaultStyle(), foreground: theme.color("status") };
	const label = input.contextLabel ? truncateToWidth(input.contextLabel, Math.max(0, frame.columns - 4)) : "";
	const leftWidth = Math.max(0, frame.columns - 2 - (label ? visibleWidth(label) + 2 : 0));
	writeText(frame, 1, y, truncateToWidth(cwd, leftWidth), left);
	if (input.contextLabel) {
		writeText(frame, Math.max(0, frame.columns - 1 - visibleWidth(label)), y, label, right);
	}
}
