import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { identityTheme, type SemanticTheme } from "../theme.ts";
import { computeEntryLayout } from "../transcript/layout.ts";

export type TimeFormatter = (timestamp: number) => string;

/** Local 12-hour clock, e.g. "3:18 PM". */
export const formatTimeHHMM: TimeFormatter = (timestamp) => {
	const date = new Date(timestamp);
	const minutes = `${date.getMinutes()}`.padStart(2, "0");
	const suffix = date.getHours() >= 12 ? "PM" : "AM";
	return `${date.getHours() % 12 || 12}:${minutes} ${suffix}`;
};

/** Compact seconds, e.g. "2.7s" / "13s". */
export function formatDurationMs(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

/** Full-width card for one user message: ❯ prefix, surface background, right-aligned timestamp. */
export class UserMessageCard implements Component {
	private text: string;
	private timestamp: number | undefined;

	constructor(
		text: string,
		timestamp: number | undefined,
		private readonly theme: SemanticTheme = identityTheme,
		private readonly formatTime: TimeFormatter = formatTimeHHMM,
	) {
		this.text = text;
		this.timestamp = timestamp;
	}

	setContent(text: string, timestamp: number | undefined): void {
		this.text = text;
		if (timestamp !== undefined) this.timestamp = timestamp;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const stamp = this.timestamp === undefined ? "" : this.formatTime(this.timestamp);
		const layout = computeEntryLayout(safeWidth, { timestamp: stamp, showPrefix: true });
		const bodyWidth = Math.max(1, layout.contentWidth - 2);
		const wrapped = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
		const rows = wrapped.length > 0 ? wrapped : [""];
		return rows.map((line, index) => {
			const prefix = index === 0 ? "❯ " : "  ";
			const text = truncateToWidth(`${prefix}${line}`, layout.contentWidth, "", false);
			const timestampText = index === 0 && layout.timestampWidth > 0 ? stamp : "";
			const timestampSegment = timestampText
				? `${" ".repeat(Math.max(0, layout.timestampWidth - visibleWidth(timestampText)))}${this.theme.muted(timestampText)}`
				: " ".repeat(layout.timestampWidth);
			const content = `${text}${" ".repeat(Math.max(0, layout.contentWidth - visibleWidth(text)))}${timestampSegment}`;
			const lineWithChrome = `${" "}${" ".repeat(layout.leftPadding)}${content}${" ".repeat(layout.rightPadding)}`;
			return this.theme.surface(truncateToWidth(lineWithChrome, safeWidth, "", true));
		});
	}

	invalidate(): void {}
}

/** Right-align a muted timestamp on the first rendered line of the wrapped component. */
export function withRightStamp(
	inner: Component,
	timestamp: number | undefined,
	theme: SemanticTheme = identityTheme,
	formatTime: TimeFormatter = formatTimeHHMM,
): Component {
	if (timestamp === undefined) return inner;
	return new RightStamped(inner, formatTime(timestamp), theme);
}

class RightStamped implements Component {
	constructor(
		private readonly inner: Component,
		private readonly stamp: string,
		private readonly theme: SemanticTheme,
	) {}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		const first = lines[0];
		if (first === undefined) return lines;
		// Markdown/Text pad lines to full width; trim trailing padding so the
		// stamp can sit at the right edge.
		const trimmed = first.replace(/ +$/, "");
		const pad = Math.max(0, Math.floor(width) - visibleWidth(trimmed) - visibleWidth(this.stamp) - 1);
		if (pad < 1) return lines;
		lines[0] = `${trimmed}${" ".repeat(pad)}${this.theme.muted(this.stamp)}`;
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}
