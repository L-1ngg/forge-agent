import type { MarkdownTheme } from "@earendil-works/pi-tui";

export const THEME_SLOTS = [
	"accent_thinking",
	"accent_plan",
	"accent_edit",
	"accent_execute",
	"status",
	"context",
	"cost",
	"activity",
	"muted",
	"error",
	"success",
	"surface",
] as const;

export type ThemeSlot = (typeof THEME_SLOTS)[number];
export type ThemeColor = (text: string) => string;
export type SemanticTheme = Record<ThemeSlot, ThemeColor>;

// Each wrap resets only its own attribute, so slots compose without clobbering
// an enclosing color (e.g. muted text inside a surface background).
const wrap = (open: string, close: string): ThemeColor => (text) => `\u001b[${open}m${text}\u001b[${close}m`;
const fg = (code: number): ThemeColor => wrap(`38;5;${code}`, "39");
const bg = (code: number): ThemeColor => wrap(`48;5;${code}`, "49");
const bold = wrap("1", "22");
const italic = wrap("3", "23");
const underline = wrap("4", "24");
const strikethrough = wrap("9", "29");

const compose = (...colors: ThemeColor[]): ThemeColor => (text) => colors.reduceRight((value, color) => color(value), text);

// 256-color palette; truecolor stays unused until E3 verifies terminal support.
const defaultPalette: SemanticTheme = {
	accent_thinking: compose(fg(139), italic),
	accent_plan: fg(175),
	accent_edit: fg(222),
	accent_execute: fg(110),
	status: fg(255),
	context: fg(81),
	cost: fg(228),
	activity: fg(245),
	muted: fg(240),
	error: fg(203),
	success: fg(114),
	surface: bg(236),
};

/** Semantic slots are the only color dependency visible to components. */
export function createSemanticTheme(overrides: Partial<SemanticTheme> = {}): SemanticTheme {
	return { ...defaultPalette, ...overrides };
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
		heading: compose(theme.status, bold),
		link: theme.context,
		linkUrl: theme.muted,
		code: theme.accent_edit,
		codeBlock: fg(252),
		codeBlockBorder: theme.muted,
		quote: theme.muted,
		quoteBorder: theme.muted,
		hr: theme.muted,
		listBullet: theme.muted,
		bold,
		italic,
		strikethrough,
		underline,
	};
}

export const createTheme = createSemanticTheme;
export const defaultTheme = createSemanticTheme();
export const semanticTheme = defaultTheme;
