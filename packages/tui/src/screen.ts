import { truncateToWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import { computeScreenLayout, type ScreenLayoutPlan } from "./layout.ts";
import { fitInteractiveRegion } from "./dock.ts";
import type { TranscriptScrollView } from "./scroll.ts";

export interface ScreenLayoutOptions {
	terminal: Terminal;
	header: Component;
	transcript: TranscriptScrollView;
	interactive: Component;
	interactiveOwner: () => "composer" | "card";
	status?: Component;
	shortcuts?: Component;
	transcriptDesired?: () => number;
	/** Fill used for outer/unused cells. The upstream agent view paints bg_base across the viewport. */
	background?: (text: string) => string;
	/** Full canvas style (foreground + background), including reset restoration. */
	canvasStyle?: (text: string) => string;
}

/**
 * Shared screen compositor for both TUI hosts.
 *
 * The host owns terminal allocation and control sequences; this component owns
 * the logical row order and the single interactive slot. Keeping this layer
 * independent from App makes deterministic captures exercise the same layout
 * path as production rendering.
 */
export class ScreenLayout implements Component {
	private lastPlan: ScreenLayoutPlan | undefined;

	constructor(private readonly options: ScreenLayoutOptions) {}

	get plan(): ScreenLayoutPlan | undefined {
		return this.lastPlan;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const owner = this.options.interactiveOwner();
		// Inner width is independent of component visibility and desired heights.
		// Compute it once before measuring children so each dynamic component is
		// read at the same width it will actually paint at.
		const widthPlan = computeScreenLayout({
			columns: safeWidth,
			rows: this.options.terminal.rows,
			headerVisible: false,
			statusVisible: false,
			interactiveDesired: 0,
			interactiveOwner: owner,
		});
		const innerWidth = widthPlan.inner.width;
		const innerHeader = this.options.header.render(innerWidth);
		const innerStatus = this.options.status?.render(innerWidth) ?? [];
		const innerShortcuts = this.options.shortcuts?.render(innerWidth) ?? [];
		const innerInteractive = this.options.interactive.render(innerWidth);
		const plan = computeScreenLayout({
			columns: safeWidth,
			rows: this.options.terminal.rows,
			headerVisible: innerHeader.length > 0,
			statusVisible: innerStatus.length > 0,
			interactiveDesired: innerInteractive.length,
			interactiveOwner: owner,
		});
		this.lastPlan = plan;
		this.options.transcript.setViewportHeight(plan.transcript.height);
		const blank = this.fill(" ".repeat(safeWidth));
		const output = Array.from({ length: Math.max(0, Math.floor(this.options.terminal.rows)) }, () => blank);
		const place = (region: ScreenLayoutPlan["header"], lines: readonly string[]): void => {
			const fitted = fitRegion(lines, region.height, plan.inner.width, this.fill.bind(this));
			for (let index = 0; index < fitted.length; index++) {
				const row = region.top + index;
				if (row < plan.inner.top || row >= plan.inner.top + plan.inner.height || row >= output.length) continue;
				output[row] = this.normalize(this.padOuter(fitted[index] ?? "", plan, safeWidth));
			}
		};
		place(plan.header, innerHeader);
		place(plan.transcript, this.options.transcript.render(plan.inner.width));
		const renderHeightAware = this.options.interactive as Component & { renderForHeight?: (width: number, height: number) => string[] };
		// Re-render only when the allocated slot is smaller than the measured
		// component. This preserves cursor-aware tail selection for long prompts
		// without probing every component twice on ordinary frames.
		const interactiveLines = renderHeightAware.renderForHeight && innerInteractive.length > plan.interactive.height
			? renderHeightAware.renderForHeight(plan.inner.width, plan.interactive.height)
			: innerInteractive;
		place(plan.interactive, fitInteractiveRegion(interactiveLines, plan.interactive.height, plan.inner.width, owner));
		place(plan.status, innerStatus);
		place(plan.shortcuts, innerShortcuts);
		return output;
	}

	private fill(value: string): string {
		return this.options.canvasStyle?.(value) ?? this.options.background?.(value) ?? value;
	}

	private normalize(value: string): string {
		if (!this.options.canvasStyle) return value;
		return restoreCanvasSgr(value, this.options.canvasStyle);
	}

	private padOuter(line: string, plan: ScreenLayoutPlan, width: number): string {
		const left = this.fill(" ".repeat(plan.outer.left));
		const right = this.fill(" ".repeat(plan.outer.right));
		return truncateToWidth(`${left}${line}${right}`, width, "", true);
	}

	invalidate(): void {
		this.options.header.invalidate();
		this.options.transcript.invalidate();
		this.options.interactive.invalidate();
		this.options.status?.invalidate();
		this.options.shortcuts?.invalidate();
	}
}

export function fitRegion(lines: readonly string[], height: number, width: number, fill?: (text: string) => string): string[] {
	const safeHeight = Math.max(0, Math.floor(height));
	const safeWidth = Math.max(1, Math.floor(width));
	const fitted = lines.slice(0, safeHeight).map((line) => truncateToWidth(line, safeWidth, "", true));
	while (fitted.length < safeHeight) fitted.push(fill?.(" ".repeat(safeWidth)) ?? " ".repeat(safeWidth));
	return fitted;
}

/** Restore the canvas style after child components reset one or more SGR attributes. */
export function restoreCanvasSgr(value: string, style: (text: string) => string): string {
	const open = leadingSgr(style(" "));
	if (!open) return value;
	const sgr = /\u001b\[([0-9;:?]*)m/g;
	let result = "";
	let cursor = 0;
	for (const match of value.matchAll(sgr)) {
		const start = match.index ?? 0;
		result += value.slice(cursor, start);
		const sequence = match[0] ?? "";
		result += sequence;
		const params = (match[1] ?? "").replaceAll(":", ";").split(";").map((part) => part === "" ? 0 : Number(part));
		if (params.some((param) => param === 0 || param === 39 || param === 49)) result += open;
		cursor = start + sequence.length;
	}
	return result + value.slice(cursor);
}

function leadingSgr(value: string): string {
	let cursor = 0;
	let result = "";
	for (;;) {
		const match = value.slice(cursor).match(/^\u001b\[[0-9;:?]*m/);
		if (!match) return result;
		result += match[0];
		cursor += match[0].length;
	}
}
