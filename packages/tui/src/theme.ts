import type { MarkdownTheme } from "@earendil-works/pi-tui";

export const THEME_SLOTS = [
	"base",
	"dark_surface",
	"accent_user",
	"accent_assistant",
	"accent_tool",
	"accent_error",
	"accent_success",
	"accent_thinking",
	"accent_plan",
	"accent_edit",
	"accent_execute",
	"accent_running",
	"status",
	"context",
	"cost",
	"activity",
	"dim",
	"muted",
	"strong",
	"thinking_body",
	"path",
	"hero_border",
	"prompt_caption",
	"prompt_border",
	"prompt_border_active",
	"error",
	"success",
	"surface",
	"surface_focus",
	"stdout_panel",
	"diff_add",
	"diff_remove",
] as const;

export type ThemeSlot = (typeof THEME_SLOTS)[number];
export type ThemeColor = (text: string) => string;
export type ThemeColorMode = "truecolor" | "256";
export type SemanticTheme = Record<Exclude<ThemeSlot, "base" | "dark_surface" | "accent_user" | "accent_assistant" | "accent_tool" | "accent_error" | "accent_success">, ThemeColor>
	& Partial<Record<Extract<ThemeSlot, "base" | "dark_surface" | "accent_user" | "accent_assistant" | "accent_tool" | "accent_error" | "accent_success">, ThemeColor>>;

// Each wrap resets only its own attribute, so slots compose without clobbering
// an enclosing color (e.g. muted text inside a surface background). Re-open
// the wrapped attribute after a full reset to emulate ratatui's parent cell
// style, which string ANSI otherwise loses.
const wrap = (open: string, close: string): ThemeColor => (text) => `\u001b[${open}m${text.replaceAll("\u001b[0m", `\u001b[0m\u001b[${open}m`)}\u001b[${close}m`;
const fg = (code: number): ThemeColor => wrap(`38;5;${code}`, "39");
const bg = (code: number): ThemeColor => wrap(`48;5;${code}`, "49");
const rgb = (r: number, g: number, b: number): ThemeColor => wrap(`38;2;${r};${g};${b}`, "39");
const rgbBg = (r: number, g: number, b: number): ThemeColor => wrap(`48;2;${r};${g};${b}`, "49");
const bold = wrap("1", "22");
const italic = wrap("3", "23");
const underline = wrap("4", "24");
const strikethrough = wrap("9", "29");

const compose = (...colors: ThemeColor[]): ThemeColor => (text) => colors.reduceRight((value, color) => color(value), text);

interface Rgb {
	r: number;
	g: number;
	b: number;
}

const color = (value: Rgb, mode: ThemeColorMode): ThemeColor => mode === "256" ? fg(nearestIndexed(value.r, value.g, value.b)) : rgb(value.r, value.g, value.b);
const background = (value: Rgb, mode: ThemeColorMode): ThemeColor => mode === "256" ? bg(nearestIndexed(value.r, value.g, value.b)) : rgbBg(value.r, value.g, value.b);

/**
 * The source-of-truth GrokNight RGB values copied as data from the upstream
 * theme. `paletteForMode` is the only place where terminal capability is
 * applied, matching ratatui's `Theme::quantized` boundary.
 */
const grokNightRgb = {
	base: [20, 20, 20],
	dark_surface: [28, 28, 28],
	accent_user: [200, 200, 200],
	accent_assistant: [187, 154, 247],
	accent_tool: [120, 120, 120],
	accent_error: [247, 118, 142],
	accent_success: [158, 206, 106],
	accent_thinking: [187, 154, 247],
	accent_plan: [255, 219, 141],
	accent_edit: [255, 158, 100],
	accent_execute: [158, 206, 106],
	accent_running: [187, 154, 247],
	status: [225, 225, 225],
	context: [122, 162, 247],
	cost: [224, 175, 104],
	activity: [125, 207, 255],
	dim: [88, 88, 88],
	muted: [108, 108, 108],
	thinking_body: [162, 162, 162],
	path: [255, 158, 100],
	hero_border: [48, 48, 48],
	prompt_caption: [128, 128, 128],
	prompt_border: [50, 50, 55],
	prompt_border_active: [80, 80, 88],
	error: [247, 118, 142],
	success: [158, 206, 106],
	surface: [36, 36, 36],
	surface_focus: [54, 54, 54],
	stdout_panel: [28, 28, 28],
	diff_add: [6, 56, 6],
	diff_remove: [66, 14, 20],
} as const;

function rgbValue(value: readonly [number, number, number]): Rgb {
	return { r: value[0], g: value[1], b: value[2] };
}

function paletteForMode(mode: ThemeColorMode): SemanticTheme {
	const p = grokNightRgb;
	return {
		base: background(rgbValue(p.base), mode),
		dark_surface: background(rgbValue(p.dark_surface), mode),
		accent_user: color(rgbValue(p.accent_user), mode),
		accent_assistant: color(rgbValue(p.accent_assistant), mode),
		accent_tool: color(rgbValue(p.accent_tool), mode),
		accent_error: color(rgbValue(p.accent_error), mode),
		accent_success: color(rgbValue(p.accent_success), mode),
		accent_thinking: compose(color(rgbValue(p.accent_thinking), mode), italic),
		accent_plan: color(rgbValue(p.accent_plan), mode),
		accent_edit: color(rgbValue(p.accent_edit), mode),
		accent_execute: color(rgbValue(p.accent_execute), mode),
		accent_running: color(rgbValue(p.accent_running), mode),
		status: color(rgbValue(p.status), mode),
		context: color(rgbValue(p.context), mode),
		cost: color(rgbValue(p.cost), mode),
		activity: color(rgbValue(p.activity), mode),
		dim: color(rgbValue(p.dim), mode),
		muted: color(rgbValue(p.muted), mode),
		strong: bold,
		thinking_body: color(rgbValue(p.thinking_body), mode),
		path: color(rgbValue(p.path), mode),
		hero_border: color(rgbValue(p.hero_border), mode),
		prompt_caption: color(rgbValue(p.prompt_caption), mode),
		prompt_border: color(rgbValue(p.prompt_border), mode),
		prompt_border_active: color(rgbValue(p.prompt_border_active), mode),
		error: color(rgbValue(p.error), mode),
		success: color(rgbValue(p.success), mode),
		surface: background(rgbValue(p.surface), mode),
		surface_focus: background(rgbValue(p.surface_focus), mode),
		stdout_panel: background(rgbValue(p.stdout_panel), mode),
		diff_add: background(rgbValue(p.diff_add), mode),
		diff_remove: background(rgbValue(p.diff_remove), mode),
	};
}

/** Semantic slots are the only color dependency visible to components. */
export interface SemanticThemeOptions {
	colorMode?: ThemeColorMode;
}

export function createSemanticTheme(overrides: Partial<SemanticTheme> = {}, options: SemanticThemeOptions = {}): SemanticTheme {
	return { ...paletteForMode(options.colorMode ?? "truecolor"), ...overrides } as SemanticTheme;
}

export function create256ColorTheme(overrides: Partial<SemanticTheme> = {}): SemanticTheme {
	return createSemanticTheme(overrides, { colorMode: "256" });
}

/** Convert a source RGB color using the same xterm 256 palette as grok-build. */
export function nearestIndexed(r: number, g: number, b: number): number {
	const cube = [0, 95, 135, 175, 215, 255] as const;
	const nearestChannel = (value: number): number => {
		let best = 0;
		let distance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < cube.length; index++) {
			const next = Math.abs(value - cube[index]!);
			if (next < distance) {
				best = index;
				distance = next;
			}
		}
		return best;
	};
	const red = nearestChannel(r);
	const green = nearestChannel(g);
	const blue = nearestChannel(b);
	const cubeIndex = 16 + 36 * red + 6 * green + blue;
	const cubeDistance = distanceSquared(r, g, b, cube[red]!, cube[green]!, cube[blue]!);
	const luminance = Math.floor((r + g + b) / 3);
	const grayStep = luminance <= 3 ? 0 : luminance >= 243 ? 23 : Math.max(0, Math.min(23, Math.floor((luminance - 3) / 10)));
	const grayValue = 8 + grayStep * 10;
	const grayDistance = distanceSquared(r, g, b, grayValue, grayValue, grayValue);
	return grayDistance < cubeDistance ? 232 + grayStep : cubeIndex;
}

function distanceSquared(r: number, g: number, b: number, rr: number, gg: number, bb: number): number {
	return (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
}

/** Unstyled theme for tests and for components constructed outside a themed app. */
export const identityTheme: SemanticTheme = Object.fromEntries(THEME_SLOTS.map((slot) => [slot, (text: string) => text])) as SemanticTheme;

/** Resolve a protocol `colorSlot` string to a slot color, or undefined when unknown. */
export function themeColor(theme: SemanticTheme, slot: string | undefined): ThemeColor | undefined {
	return slot !== undefined && (THEME_SLOTS as readonly string[]).includes(slot) ? theme[slot as ThemeSlot] : undefined;
}

/** Map semantic slots onto pi-tui's markdown renderer. */
export function markdownThemeFromSlots(theme: SemanticTheme): MarkdownTheme {
	return {
		heading: compose(theme.status, theme.strong),
		link: theme.context,
		linkUrl: theme.muted,
		code: theme.accent_edit,
		// Keep markdown code blocks in the same explicit color mode as the rest
		// of the semantic theme. A fixed ANSI index here would silently mix
		// truecolor and 256-color output in one frame.
		codeBlock: theme.status,
		codeBlockBorder: theme.muted,
		quote: theme.muted,
		quoteBorder: theme.muted,
		hr: theme.muted,
		listBullet: theme.muted,
		bold: theme.strong,
		italic,
		strikethrough,
		underline,
	};
}

export const createTheme = createSemanticTheme;
export const defaultTheme = createSemanticTheme();
export const semanticTheme = defaultTheme;

/** Paint text and blank cells with the same base style used by the upstream canvas. */
export function canvasStyle(theme: SemanticTheme, text: string): string {
	const withBackground = theme.base ? theme.base(text) : text;
	return theme.status(withBackground);
}
