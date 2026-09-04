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

export function abbreviateHome(cwd: string, homeDir: string | undefined): string {
	if (homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))) return `~${cwd.slice(homeDir.length)}`;
	return cwd;
}

/**
 * Match grok-build's compact token formatter.
 *
 * The first decimal bucket intentionally rounds (`9_960 -> 10.0K`), while
 * values at 10K and above use whole thousands. This keeps the display within
 * four cells without dropping useful precision near the bucket boundary.
 */
export function formatCompact(value: number): string {
	const normalized = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
	if (normalized < 1_000) return `${normalized}`;
	if (normalized < 10_000) return `${(normalized / 1_000).toFixed(1)}K`;
	if (normalized < 1_000_000) return `${Math.floor(normalized / 1_000)}K`;
	if (normalized < 10_000_000) return `${(normalized / 1_000_000).toFixed(1)}M`;
	return `${Math.floor(normalized / 1_000_000)}M`;
}
