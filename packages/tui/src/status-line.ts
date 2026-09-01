import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
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

/** Format only metrics that are known at this render point. */
export function formatStatusLine(state: StatusLineState = {}, width?: number): string {
	const segments: string[] = [];
	const contextTokens = finiteNonNegative(state.contextTokens);
	const contextWindow = finitePositive(state.contextWindow);
	if (contextTokens !== undefined) {
		const marker = state.contextEstimated ? "~" : "";
		segments.push(contextWindow === undefined ? `ctx ${marker}${formatNumber(contextTokens)}` : `ctx ${marker}${formatNumber(contextTokens)}/${formatNumber(contextWindow)} (${Math.min(100, (contextTokens / contextWindow) * 100).toFixed(0)}%)`);
	}
	if (state.running !== undefined && finiteNonNegative(state.running) !== undefined) segments.push(`running ${Math.floor(state.running)}`);
	const cost = finiteNonNegative(state.costUsd ?? state.cost);
	if (cost !== undefined && cost >= MIN_DISPLAYED_COST_USD) segments.push(`$${cost.toFixed(3)}`);
	if (state.provider) segments.push(state.model ? `${state.provider}/${state.model}` : state.provider);
	else if (state.model) segments.push(state.model);
	if (state.turn !== undefined && finiteNonNegative(state.turn) !== undefined) segments.push(`turn ${Math.floor(state.turn)}`);
	const result = segments.join(" | ");
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

	render(width: number): string[] {
		const state = this.currentState();
		const segments: string[] = [];
		const context = formatContext(state);
		if (context) segments.push(this.theme.context(context));
		if (state.running !== undefined && finiteNonNegative(state.running) !== undefined) segments.push(this.theme.activity(`running ${Math.floor(state.running)}`));
		const cost = finiteNonNegative(state.costUsd ?? state.cost);
		if (cost !== undefined && cost >= MIN_DISPLAYED_COST_USD) segments.push(this.theme.cost(`$${cost.toFixed(3)}`));
		const identity = state.provider ? (state.model ? `${state.provider}/${state.model}` : state.provider) : state.model;
		if (identity) segments.push(this.theme.status(identity));
		if (state.turn !== undefined && finiteNonNegative(state.turn) !== undefined) segments.push(this.theme.muted(`turn ${Math.floor(state.turn)}`));
		const line = truncateToWidth(segments.join(" | "), Math.max(0, Math.floor(width)));
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
