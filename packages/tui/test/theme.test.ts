import { expect, test } from "bun:test";
import { create256ColorTheme, createSemanticTheme, frameFromLines, markdownThemeFromSlots, nearestIndexed } from "../src/index.ts";

test("semantic theme applies one explicit color mode to the complete palette", () => {
	const truecolor = createSemanticTheme();
	const indexed = create256ColorTheme();
	for (const [slot, expectedRgb, expectedIndex] of [
		["base", { r: 20, g: 20, b: 20 }, 233],
		["status", { r: 225, g: 225, b: 225 }, 254],
		["muted", { r: 108, g: 108, b: 108 }, 242],
		["prompt_border", { r: 50, g: 50, b: 55 }, 236],
		["prompt_border_active", { r: 80, g: 80, b: 88 }, 239],
	] as const) {
		const truecolorCell = frameFromLines([truecolor[slot]!("x")], 1, 1).cells[0]?.[0];
		const indexedCell = frameFromLines([indexed[slot]!("x")], 1, 1).cells[0]?.[0];
		const channel = slot === "base" ? "background" : "foreground";
		expect(truecolorCell?.[channel]).toEqual({ kind: "rgb", ...expectedRgb });
		expect(indexedCell?.[channel]).toEqual({ kind: "indexed", index: expectedIndex });
	}
});

test("xterm quantizer matches upstream cube and grayscale tie-breaking", () => {
	expect(nearestIndexed(20, 20, 20)).toBe(233);
	expect(nearestIndexed(225, 225, 225)).toBe(254);
	expect(nearestIndexed(95, 135, 215)).toBe(68);
	expect(nearestIndexed(247, 118, 142)).toBe(210);
});

test("markdown code blocks inherit the theme color mode", () => {
	const truecolor = markdownThemeFromSlots(createSemanticTheme());
	const indexed = markdownThemeFromSlots(create256ColorTheme());
	const truecolorCell = frameFromLines([truecolor.codeBlock("x")], 1, 1).cells[0]?.[0];
	const indexedCell = frameFromLines([indexed.codeBlock("x")], 1, 1).cells[0]?.[0];
	expect(truecolorCell?.foreground).toEqual({ kind: "rgb", r: 225, g: 225, b: 225 });
	expect(indexedCell?.foreground).toEqual({ kind: "indexed", index: 254 });
});
