import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Composer } from "./editor.ts";
import { restoreCanvasSgr } from "./screen.ts";
import { defaultTheme, nearestIndexed, type SemanticTheme, type ThemeColorMode } from "./theme.ts";

/** Stable copy of the upstream Grok Build hero logo (logo07.txt). */
export const GROK_BUILD_LOGO = [
	"⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄",
	"⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀",
	"⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀",
	"⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀",
	"⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀",
	"⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀",
	"⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
] as const;

export const GROK_BUILD_MENU = [
	{ label: "New worktree", shortcut: "ctrl+w" },
	{ label: "Resume session", shortcut: "f3" },
	{ label: "Changelog", shortcut: "" },
	{ label: "Quit", shortcut: "ctrl+q" },
] as const;

export interface WelcomeScreenOptions {
	tui: TUI;
	composer: Composer;
	theme?: SemanticTheme;
	version?: string;
	location?: string;
	loggedIn?: boolean;
	/** Fixed upstream shimmer phase. Omit it to keep the logo at rest. */
	animationSeconds?: number;
	/** Color capability used when calculating the canonical GrokNight shimmer. */
	animationColorMode?: ThemeColorMode;
	onNewWorktree?: () => void;
	onResume?: () => void;
	onChangelog?: () => void;
	onQuit?: () => void;
}

export interface WelcomeLayoutPlan {
	columns: number;
	rows: number;
	compact: boolean;
	hero: { x: number; y: number; width: number; height: number } | undefined;
	prompt: { x: number; y: number; width: number; height: number };
	locationRow: number;
	statusRow: number | undefined;
}

interface HeroRowSegment {
	offset: number;
	text: string;
}

/**
 * Deterministic welcome page matching the stable upstream 100x32/90x28
 * capture. The shimmer is intentionally omitted from canonical rendering;
 * callers can opt into animation later without changing geometry.
 */
export class WelcomeScreen implements Component, Focusable {
	private readonly theme: SemanticTheme;
	private readonly version: string;
	private readonly location: string;
	private readonly loggedIn: boolean;
	private readonly animationSeconds: number | undefined;
	private readonly animationColorMode: ThemeColorMode;
	private selected: number | undefined;
	private planValue: WelcomeLayoutPlan | undefined;

	constructor(private readonly options: WelcomeScreenOptions) {
		this.theme = options.theme ?? defaultTheme;
		this.version = options.version?.trim() || "1.0.12";
		this.location = options.location ?? "~";
		this.loggedIn = options.loggedIn ?? true;
		this.animationSeconds = options.animationSeconds === undefined ? undefined : Math.max(0, options.animationSeconds);
		this.animationColorMode = options.animationColorMode ?? "truecolor";
	}

	get focused(): boolean {
		return this.options.composer.focused;
	}

	set focused(value: boolean) {
		this.options.composer.focused = value;
	}

	get plan(): WelcomeLayoutPlan | undefined {
		return this.planValue;
	}

	get selectedIndex(): number | undefined {
		return this.selected;
	}

	render(width: number): string[] {
		const columns = Math.max(1, Math.floor(width));
		const rows = Math.max(1, Math.floor(this.options.tui.terminal.rows));
		const layout = computeWelcomeLayout(columns, rows);
		this.planValue = layout;
		const blank = this.paintCanvas(" ".repeat(columns));
		const output = Array.from({ length: rows }, () => blank);
		const put = (y: number, x: number, value: string): void => {
			if (y < 0 || y >= rows) return;
			const leftWidth = Math.max(0, Math.min(columns, Math.floor(x)));
			const clipped = truncateToWidth(value, Math.max(0, columns - leftWidth), "", false);
			const rightWidth = Math.max(0, columns - leftWidth - visibleWidth(stripTerminalSequences(clipped)));
			output[y] = this.paintCanvas(`${" ".repeat(leftWidth)}${clipped}${" ".repeat(rightWidth)}`);
		};
		put(layout.locationRow, layout.compact ? 1 : 2, this.theme.dim(this.location));
		if (layout.hero) this.renderHero(layout.hero, put);
		const promptLines = this.options.composer.render(layout.prompt.width);
		for (let index = 0; index < layout.prompt.height; index++) {
			const line = promptLines[index] ?? this.fill(" ".repeat(layout.prompt.width));
			put(layout.prompt.y + index, layout.prompt.x, line);
		}
		if (layout.statusRow !== undefined && this.loggedIn) {
			const status = this.theme.muted("Logged in with API key");
			const x = Math.max(0, columns - 2 - visibleWidth("Logged in with API key"));
			put(layout.statusRow, x, status);
		}
		return output;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("w"))) return void this.options.onNewWorktree?.();
		if (matchesKey(data, Key.f3)) return void this.options.onResume?.();
		if (matchesKey(data, Key.ctrl("q"))) return void this.options.onQuit?.();
		if (this.options.composer.focused) {
			if (data === "\u001b" || matchesKey(data, Key.escape)) {
				this.options.composer.focused = false;
				this.options.tui.requestRender();
				return;
			}
			this.options.composer.handleInput(data);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = this.selected === undefined ? GROK_BUILD_MENU.length - 1 : (this.selected + GROK_BUILD_MENU.length - 1) % GROK_BUILD_MENU.length;
			this.options.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = this.selected === undefined ? 0 : (this.selected + 1) % GROK_BUILD_MENU.length;
			this.options.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) && this.selected !== undefined) {
			this.activate(this.selected);
			return;
		}
		this.selected = undefined;
		this.options.composer.focused = true;
		this.options.composer.handleInput(data);
		this.options.tui.requestRender();
	}

	invalidate(): void {
		this.options.composer.invalidate();
	}

	private renderHero(hero: WelcomeLayoutPlan["hero"] & object, put: (y: number, x: number, value: string) => void): void {
		const border = this.theme.hero_border ?? this.theme.muted;
		const borderLine = border("╭" + "─".repeat(Math.max(0, hero.width - 2)) + "╮");
		const bottomLine = border("╰" + "─".repeat(Math.max(0, hero.width - 2)) + "╯");
		put(hero.y, hero.x, borderLine);
		for (let row = 1; row < hero.height - 1; row++) {
			const inner = " ".repeat(hero.width - 2);
			put(hero.y + row, hero.x, border("│") + inner + border("│"));
		}
		for (let row = 0; row < GROK_BUILD_LOGO.length && row + 2 < hero.height - 1; row++) {
			const y = hero.y + 2 + row;
			const segments: HeroRowSegment[] = [{ offset: 0, text: border("│") }, { offset: 3, text: this.renderLogoRow(GROK_BUILD_LOGO[row]!, row) }];
			if (row === 0) segments.push({ offset: 20, text: this.theme.strong(this.theme.status("Grok Build  ")) }, { offset: 32, text: this.theme.muted(this.version) });
			else if (row === 1) segments.push({ offset: 20, text: this.theme.muted("Thanks for trying Grok Build, give feedback with /feedback!") });
			else if (row >= 3) {
				const item = GROK_BUILD_MENU[row - 3]!;
				if (this.selected === row - 3) segments.push({ offset: 20, text: this.renderSelectedMenuRow(hero.width - 23, item.label, item.shortcut) });
				else {
					segments.push({ offset: 20, text: this.theme.strong(this.theme.status(item.label)) });
					if (item.shortcut) segments.push({ offset: hero.width - 3 - visibleWidth(item.shortcut), text: this.theme.accent_tool?.(item.shortcut) ?? item.shortcut });
				}
			}
			segments.push({ offset: hero.width - 1, text: border("│") });
			put(y, hero.x, renderSegments(hero.width, segments));
		}
		put(hero.y + hero.height - 1, hero.x, bottomLine);
	}

	private renderSelectedMenuRow(width: number, label: string, shortcut: string): string {
		const safeWidth = Math.max(0, Math.floor(width));
		const shortcutWidth = visibleWidth(shortcut);
		const maxLabel = Math.max(0, safeWidth - shortcutWidth - (shortcut ? 1 : 0));
		const clippedLabel = truncateToWidth(label, maxLabel, "", false);
		const gap = Math.max(0, safeWidth - visibleWidth(clippedLabel) - shortcutWidth);
		const labelPart = this.theme.surface(this.theme.strong(this.theme.status(clippedLabel)));
		const gapPart = this.theme.surface(" ".repeat(gap));
		const shortcutPart = this.theme.surface(this.theme.accent_tool?.(shortcut) ?? shortcut);
		return `${labelPart}${gapPart}${shortcutPart}`;
	}

	private renderLogoRow(line: string, row: number): string {
		if (this.animationSeconds === undefined) return this.theme.muted(line);
		const columns = Math.max(...GROK_BUILD_LOGO.map((value) => [...value].length));
		const rows = GROK_BUILD_LOGO.length;
		let result = "";
		let run = "";
		let runColor = "";
		for (const [column, glyph] of [...line].entries()) {
			const diagonal = (column + (rows - 1 - row)) / (columns + rows);
			const color = logoColor(shineOpacity(diagonal, this.animationSeconds), this.animationColorMode);
			if (run && color !== runColor) {
				result += `${runColor}${run}\u001b[39m`;
				run = "";
			}
			runColor = color;
			run += glyph;
		}
		return run ? `${result}${runColor}${run}\u001b[39m` : result;
	}

	private fill(value: string): string {
		return this.theme.base?.(value) ?? value;
	}

	private paintCanvas(value: string): string {
		return restoreCanvasSgr(this.fill(value), (text) => this.fill(text));
	}

	private activate(index: number): void {
		if (index === 0) this.options.onNewWorktree?.();
		else if (index === 1) this.options.onResume?.();
		else if (index === 2) this.options.onChangelog?.();
		else this.options.onQuit?.();
	}
}

function renderSegments(width: number, segments: readonly HeroRowSegment[]): string {
	let cursor = 0;
	let result = "";
	for (const segment of [...segments].sort((left, right) => left.offset - right.offset)) {
		const offset = Math.max(cursor, Math.min(width, Math.floor(segment.offset)));
		if (offset > cursor) result += " ".repeat(offset - cursor);
		const clipped = truncateToWidth(segment.text, Math.max(0, width - offset), "", false);
		result += clipped;
		cursor = offset + visibleWidth(stripTerminalSequences(clipped));
		if (cursor >= width) break;
	}
	if (cursor < width) result += " ".repeat(width - cursor);
	return result;
}

function shineOpacity(diagonal: number, seconds: number): number {
	const band = 0.38;
	const cycle = 4;
	const sweepFraction = 0.32;
	const shineStrength = 0.33;
	const pulseStrength = 0.06;
	const pulseSeconds = 5;
	const progress = (seconds % cycle) / cycle;
	const sweep = Math.min(progress / sweepFraction, 1);
	const bandPosition = -band + sweep * (1 + 2 * band);
	const pulse = pulseStrength * (0.5 - 0.5 * Math.cos(Math.PI * 2 * seconds / pulseSeconds));
	const distance = Math.abs(diagonal - bandPosition);
	const shine = distance < band ? 0.5 * (1 + Math.cos(Math.PI * distance / band)) : 0;
	return Math.max(0, Math.min(1, pulse + shineStrength * shine));
}

function logoColor(opacity: number, mode: ThemeColorMode): string {
	const base = mode === "256" ? indexedRgb(nearestIndexed(108, 108, 108)) : 108;
	const highlight = mode === "256" ? indexedRgb(nearestIndexed(225, 225, 225)) : 225;
	const channel = Math.round(base * (1 - opacity) + highlight * opacity);
	return mode === "256"
		? `\u001b[38;5;${nearestIndexed(channel, channel, channel)}m`
		: `\u001b[38;2;${channel};${channel};${channel}m`;
}

function indexedRgb(index: number): number {
	if (index >= 232) return 8 + (index - 232) * 10;
	if (index < 16) return index === 0 ? 0 : index === 15 ? 255 : index < 8 ? 128 : 192;
	const cube = [0, 95, 135, 175, 215, 255] as const;
	return cube[Math.floor((index - 16) / 36)] ?? 0;
}

export function computeWelcomeLayout(columns: number, rows: number): WelcomeLayoutPlan {
	const safeColumns = Math.max(1, Math.floor(columns));
	const safeRows = Math.max(1, Math.floor(rows));
	const compact = safeColumns < 20 || safeRows < 10;
	const horizontalInset = compact ? 0 : 2;
	const promptWidth = Math.max(1, safeColumns - horizontalInset * 2);
	const promptY = Math.max(0, safeRows - 6);
	const contentHeight = Math.max(0, safeRows - 3);
	let hero: WelcomeLayoutPlan["hero"];
	if (safeColumns >= 90 && contentHeight >= 17) {
		const width = Math.min(120, safeColumns - 6);
		const height = 11;
		const fixedBelow = 5;
		const topPad = Math.min(
			Math.floor(Math.max(0, contentHeight - height - fixedBelow) / 3),
			Math.max(0, contentHeight - height - 1 - fixedBelow),
		);
		hero = { x: Math.floor((safeColumns - width) / 2), y: 2 + topPad, width, height };
	}
	return {
		columns: safeColumns,
		rows: safeRows,
		compact,
		hero,
		prompt: { x: horizontalInset, y: promptY, width: promptWidth, height: Math.min(3, safeRows - promptY) },
		locationRow: Math.min(1, safeRows - 1),
		statusRow: safeRows >= 2 ? safeRows - 2 : undefined,
	};
}
