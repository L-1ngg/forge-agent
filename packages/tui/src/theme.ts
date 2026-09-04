import type { TerminalColor } from "./frame.ts";

/**
 * Semantic color slots as data, resolved to cell colors at the theme
 * boundary (phase 2.2 B1). Slot names and GrokNight RGB values are the ones
 * locked in earlier phases; the output is TerminalColor, not ANSI strings.
 */
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

/**
 * GrokNight palette, copied as data from the upstream theme.
 * `strong` is deliberately absent: it is an attribute slot (bold), not a color.
 */
const GROK_NIGHT_RGB: Record<Exclude<ThemeSlot, "strong">, readonly [number, number, number]> = {
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
};

export type ThemeColorMode = "truecolor" | "256";

/** Resolve terminal capability once, at the theme boundary. */
export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ThemeColorMode {
	const colorTerm = env.COLORTERM?.toLowerCase();
	if (colorTerm === "truecolor" || colorTerm === "24bit") return "truecolor";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.includes("256color")) return "256";
	if (term === "dumb") return "256";
	return "truecolor";
}

export interface Theme {
	readonly mode: ThemeColorMode;
	/** Slot color, quantized to the detected capability. `strong` carries no color. */
	color(slot: ThemeSlot): TerminalColor;
	/** Attribute slots: only `strong` (bold) today. */
	attributes(slot: ThemeSlot): { bold: boolean };
	/** Raw GrokNight RGB for fixtures and parity comparisons; undefined for `strong`. */
	rgb(slot: ThemeSlot): readonly [number, number, number] | undefined;
}

export function createTheme(options: { mode?: ThemeColorMode; env?: NodeJS.ProcessEnv } = {}): Theme {
	const mode = options.mode ?? detectColorMode(options.env);
	return {
		mode,
		color(slot) {
			const entry = GROK_NIGHT_RGB[slot as Exclude<ThemeSlot, "strong">];
			if (!entry) return { kind: "default" };
			const [r, g, b] = entry;
			return mode === "256" ? { kind: "indexed", index: nearestIndexed(r, g, b) } : { kind: "rgb", r, g, b };
		},
		attributes(slot) {
			return { bold: slot === "strong" };
		},
		rgb(slot) {
			return GROK_NIGHT_RGB[slot as Exclude<ThemeSlot, "strong">];
		},
	};
}

/** Quantize RGB onto the xterm 256 palette (color cube vs grayscale ramp). */
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
