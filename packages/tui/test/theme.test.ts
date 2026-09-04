import { expect, test } from "bun:test";
import { THEME_SLOTS, createTheme, detectColorMode, nearestIndexed } from "../src/index.ts";

test("all 32 semantic slots are resolvable", () => {
	expect(THEME_SLOTS).toHaveLength(32);
	const theme = createTheme({ mode: "truecolor" });
	for (const slot of THEME_SLOTS) {
		expect(theme.color(slot)).toBeDefined();
		expect(theme.attributes(slot)).toBeDefined();
	}
});

test("truecolor mode returns the GrokNight RGB data", () => {
	const theme = createTheme({ mode: "truecolor" });
	expect(theme.color("accent_assistant")).toEqual({ kind: "rgb", r: 187, g: 154, b: 247 });
	expect(theme.color("diff_remove")).toEqual({ kind: "rgb", r: 66, g: 14, b: 20 });
	expect(theme.rgb("base")).toEqual([20, 20, 20]);
});

test("256 mode quantizes at the theme boundary", () => {
	const theme = createTheme({ mode: "256" });
	// base [20,20,20]: grayscale ramp (18) beats the color cube (0,0,0).
	expect(theme.color("base")).toEqual({ kind: "indexed", index: 233 });
	expect(theme.color("accent_error")).toEqual({ kind: "indexed", index: nearestIndexed(247, 118, 142) });
});

test("strong is a bold attribute slot with no color", () => {
	const theme = createTheme({ mode: "truecolor" });
	expect(theme.attributes("strong")).toEqual({ bold: true });
	expect(theme.attributes("muted")).toEqual({ bold: false });
	expect(theme.color("strong")).toEqual({ kind: "default" });
	expect(theme.rgb("strong")).toBeUndefined();
});

test("detectColorMode follows COLORTERM and TERM", () => {
	expect(detectColorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
	expect(detectColorMode({ COLORTERM: "24bit" })).toBe("truecolor");
	expect(detectColorMode({ TERM: "xterm-256color" })).toBe("256");
	expect(detectColorMode({ TERM: "dumb" })).toBe("256");
	expect(detectColorMode({})).toBe("truecolor");
});

test("nearestIndexed picks the closer of color cube and grayscale ramp", () => {
	expect(nearestIndexed(0, 0, 0)).toBe(16); // exact cube black beats gray 0? cube wins on tie distance
	expect(nearestIndexed(255, 255, 255)).toBe(231); // cube white
	expect(nearestIndexed(128, 128, 128)).toBe(244); // gray ramp
	expect(nearestIndexed(255, 0, 0)).toBe(196); // cube red
});
