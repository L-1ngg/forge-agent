import { defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import { truncateToWidth } from "./width.ts";
import type { Theme } from "./theme.ts";

/**
 * Status segments with honesty rules (phase 2 M6): unknown fields are
 * omitted, cost below $0.005 is hidden, running state lives here only.
 */
export interface StatusInput {
	provider?: string;
	model?: string;
	/** e.g. "13K / 1.0M"; omitted when unknown. */
	contextLabel?: string;
	/** USD; hidden below 0.005. */
	cost?: number;
	/** Running activity label (e.g. "esc to interrupt"); replaces idle hints. */
	activity?: string;
}

export function buildStatusSegments(input: StatusInput): string[] {
	const segments: string[] = [];
	if (input.provider && input.model) segments.push(`${input.provider}/${input.model}`);
	if (input.contextLabel) segments.push(input.contextLabel);
	if (input.cost !== undefined && input.cost >= 0.005) segments.push(`$${input.cost.toFixed(4)}`);
	if (input.activity) segments.push(input.activity);
	return segments;
}

export const STATUS_SEPARATOR = " │ ";

export function paintStatus(frame: TerminalFrame, y: number, segments: readonly string[], theme: Theme): void {
	if (y >= frame.rows || segments.length === 0) return;
	writeText(frame, 1, y, truncateToWidth(segments.join(STATUS_SEPARATOR), frame.columns - 2), { ...defaultStyle(), foreground: theme.color("dim") });
}
