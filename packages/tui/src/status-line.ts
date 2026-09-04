import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ContextUsageSnapshot } from "@myh/protocol";
import { defaultTheme, type SemanticTheme } from "./theme.ts";

export const MIN_DISPLAYED_COST_USD = 0.005;

export interface StatusLineState extends ContextUsageSnapshot {
	provider?: string;
	model?: string;
	turn?: number;
	/** Convenience alias accepted by callers that already have a cost value. */
	cost?: number;
}

export interface StatusLineOptions {
	state?: StatusLineState;
	getState?: () => StatusLineState;
	theme?: SemanticTheme;
}

export interface StatusSegment {
	text: string;
	styled: string;
	/** Keeps the segment's semantic color independent from dock composition. */
	tone: "context" | "activity" | "cost" | "status" | "muted";
}

export const STATUS_SEGMENT_SEPARATOR = " │ ";

/** Format only metrics that are known at this render point. */
export function formatStatusLine(state: StatusLineState = {}, width?: number): string {
	const segments: string[] = [];
	const contextTokens = finiteNonNegative(state.contextTokens);
	const contextWindow = finitePositive(state.contextWindow);
	if (contextTokens !== undefined) {
		const marker = state.contextEstimated ? "~" : "";
		segments.push(contextWindow === undefined ? `ctx ${marker}${formatNumber(contextTokens)}` : `ctx ${marker}${formatNumber(contextTokens)}/${formatNumber(contextWindow)} (${Math.min(100, (contextTokens / contextWindow) * 100).toFixed(0)}%)`);
	}
	const running = finitePositive(state.running);
	if (running !== undefined) segments.push(`running ${Math.floor(running)}`);
	const cost = finiteNonNegative(state.costUsd ?? state.cost);
	if (cost !== undefined && cost >= MIN_DISPLAYED_COST_USD) segments.push(`$${cost.toFixed(3)}`);
	if (state.provider) segments.push(state.model ? `${state.provider}/${state.model}` : state.provider);
	else if (state.model) segments.push(state.model);
	const turn = finitePositive(state.turn);
	if (turn !== undefined) segments.push(`turn ${Math.floor(turn)}`);
	const result = segments.join(STATUS_SEGMENT_SEPARATOR);
	return width === undefined ? result : truncateToWidth(result, Math.max(0, Math.floor(width)));
}

export const renderStatusLine = formatStatusLine;

/** A one-row component that can pull fresh state on every render. */
export class StatusLine implements Component {
	private state: StatusLineState;
	private readonly getState: (() => StatusLineState) | undefined;
	private readonly theme: SemanticTheme;

	constructor(options: StatusLineOptions = {}) {
		this.state = { ...(options.state ?? {}) };
		this.getState = options.getState;
		this.theme = options.theme ?? defaultTheme;
	}

	setState(state: StatusLineState): void {
		this.state = { ...state };
	}

	update(state: StatusLineState): void {
		this.setState(state);
	}

	getStateSnapshot(): StatusLineState {
		return { ...this.currentState() };
	}

	/** Return independently styled segments for the agent-view status dock. */
	renderSegments(width?: number): StatusSegment[] {
		const state = this.currentState();
		const segments: StatusSegment[] = [];
		const context = formatContext(state);
		if (context) segments.push({ text: context, styled: this.theme.context(context), tone: "context" });
		const running = finitePositive(state.running);
		if (running !== undefined) {
			const text = `running ${Math.floor(running)}`;
			segments.push({ text, styled: this.theme.activity(text), tone: "activity" });
		}
		const cost = finiteNonNegative(state.costUsd ?? state.cost);
		if (cost !== undefined && cost >= MIN_DISPLAYED_COST_USD) {
			const text = `$${cost.toFixed(3)}`;
			segments.push({ text, styled: this.theme.cost(text), tone: "cost" });
		}
		const identity = state.provider ? (state.model ? `${state.provider}/${state.model}` : state.provider) : state.model;
		if (identity) segments.push({ text: identity, styled: this.theme.status(identity), tone: "status" });
		const turn = finitePositive(state.turn);
		if (turn !== undefined) {
			const text = `turn ${Math.floor(turn)}`;
			segments.push({ text, styled: this.theme.muted(text), tone: "muted" });
		}
		if (width === undefined) return segments;
		return fitStatusSegments(segments, width);
	}

	render(width: number): string[] {
		const state = this.currentState();
		const segments = this.renderSegments(width);
		const line = segments.map((segment) => segment.styled).join(STATUS_SEGMENT_SEPARATOR);
		return line ? [line] : [];
	}

	invalidate(): void {}

	private currentState(): StatusLineState {
		return this.getState ? { ...this.state, ...this.getState() } : { ...this.state };
	}
}

export const StatusBar = StatusLine;

function formatContext(state: StatusLineState): string | undefined {
	const tokens = finiteNonNegative(state.contextTokens);
	if (tokens === undefined) return undefined;
	const window = finitePositive(state.contextWindow);
	const marker = state.contextEstimated ? "~" : "";
	return window === undefined ? `ctx ${marker}${formatNumber(tokens)}` : `ctx ${marker}${formatNumber(tokens)}/${formatNumber(window)} (${Math.min(100, (tokens / window) * 100).toFixed(0)}%)`;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.floor(value));
}

function finiteNonNegative(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositive(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function fitStatusSegments(segments: readonly StatusSegment[], width: number): StatusSegment[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return [];
	const fitted: StatusSegment[] = [];
	let used = 0;
	for (const segment of segments) {
		const separator = fitted.length === 0 ? 0 : visibleWidth(STATUS_SEGMENT_SEPARATOR);
		if (used + separator + visibleWidth(segment.text) > safeWidth) break;
		fitted.push(segment);
		used += separator + visibleWidth(segment.text);
	}
	if (fitted.length > 0) return fitted;
	const first = segments[0];
	if (!first) return [];
	const text = truncateToWidth(stripTerminalSequences(first.styled), safeWidth, "…", true);
	return text ? [{ ...first, text: stripTerminalSequences(text), styled: first.tone === "context" ? text : text }] : [];
}
