import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ContextUsageSnapshot } from "@myh/protocol";
import { identityTheme, type SemanticTheme } from "./theme.ts";

export interface HeaderBarOptions {
	cwd?: string;
	/** Home directory used only to abbreviate the cwd display to "~". */
	homeDir?: string;
	getUsage?: () => ContextUsageSnapshot | undefined;
	theme?: SemanticTheme;
}

/** Top row: working directory on the left, live context usage on the right. */
export class HeaderBar implements Component {
	private readonly cwd: string | undefined;
	private readonly homeDir: string | undefined;
	private readonly getUsage: (() => ContextUsageSnapshot | undefined) | undefined;
	private readonly theme: SemanticTheme;

	constructor(options: HeaderBarOptions = {}) {
		this.cwd = options.cwd;
		this.homeDir = options.homeDir;
		this.getUsage = options.getUsage;
		this.theme = options.theme ?? identityTheme;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const left = this.cwd === undefined ? "" : abbreviateHome(this.cwd, this.homeDir);
		const right = this.formatUsage();
		if (!left && !right) return [];
		if (!right) return [truncateToWidth(this.theme.muted(left), safeWidth)];
		const leftRendered = this.theme.muted(left);
		const rightRendered = this.theme.context(right);
		const pad = safeWidth - visibleWidth(left) - visibleWidth(right) - 1;
		if (pad < 1) return [truncateToWidth(`${leftRendered} ${rightRendered}`, safeWidth)];
		return [`${leftRendered}${" ".repeat(pad)}${rightRendered}`];
	}

	invalidate(): void {}

	private formatUsage(): string {
		const usage = this.getUsage?.();
		const tokens = usage?.contextTokens;
		if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return "";
		const window = usage?.contextWindow;
		if (window === undefined || !Number.isFinite(window) || window <= 0) return formatCompact(tokens);
		return `${formatCompact(tokens)} / ${formatCompact(window)}`;
	}
}

function abbreviateHome(cwd: string, homeDir: string | undefined): string {
	if (homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))) return `~${cwd.slice(homeDir.length)}`;
	return cwd;
}

/** Compact token counts, e.g. "13K" / "1.0M". */
export function formatCompact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return `${Math.floor(value)}`;
}
