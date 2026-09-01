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
] as const;

export type ThemeSlot = (typeof THEME_SLOTS)[number];
export type ThemeColor = (text: string) => string;
export type SemanticTheme = Record<ThemeSlot, ThemeColor>;

const identity: ThemeColor = (text) => text;

/** Semantic slots are the only color dependency visible to components. */
export function createSemanticTheme(overrides: Partial<SemanticTheme> = {}): SemanticTheme {
	return Object.fromEntries(THEME_SLOTS.map((slot) => [slot, overrides[slot] ?? identity])) as SemanticTheme;
}

export const createTheme = createSemanticTheme;
export const defaultTheme = createSemanticTheme();
export const semanticTheme = defaultTheme;
