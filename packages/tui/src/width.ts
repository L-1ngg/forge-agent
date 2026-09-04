/**
 * Self-owned Unicode width policy (phase 2.2 B1). No third-party width
 * dependency; behavior is locked by table-driven tests in test/width.test.ts.
 *
 * Policy:
 * - Grapheme segmentation via Intl.Segmenter.
 * - Control characters (Cc) have width 0 and are never painted.
 * - Graphemes made only of marks/format chars (combining, VS, ZWJ) have width 0
 *   and attach to the preceding cell when written to a frame.
 * - East Asian Wide/Fullwidth ranges have width 2.
 * - Emoji: Extended_Pictographic with emoji presentation, VS16, modifier,
 *   keycap, or Regional Indicator sequences have width 2; a bare
 *   Extended_Pictographic codepoint in text presentation has width 1.
 * - Everything else has width 1.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemes(text: string): string[] {
	const result: string[] = [];
	for (const segment of segmenter.segment(text)) result.push(segment.segment);
	return result;
}

// East Asian Wide/Fullwidth ranges (wcwidth lineage), excluding emoji handled
// by the presentation rules below.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f],
	[0x2329, 0x232a],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe4f],
	[0xfe54, 0xfe66],
	[0xfe69, 0xfe6b],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x17000, 0x187f7],
	[0x18800, 0x18cd5],
	[0x18d00, 0x18d08],
	[0x1aff0, 0x1afff],
	[0x1b000, 0x1b152],
	[0x1b164, 0x1b167],
	[0x1b170, 0x1b2fb],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f202],
	[0x1f210, 0x1f23b],
	[0x1f240, 0x1f248],
	[0x1f250, 0x1f251],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const MARK_OR_FORMAT = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
const CONTROL = /^[\p{Cc}]/u;
const VS16 = "️"; // U+FE0F
const KEYCAP = "⃣"; // U+20E3

function isWideCodepoint(codepoint: number): boolean {
	for (const [lo, hi] of WIDE_RANGES) {
		if (codepoint >= lo && codepoint <= hi) return true;
	}
	return false;
}

function isEmojiWide(grapheme: string): boolean {
	if (REGIONAL_INDICATOR.test(grapheme)) return true;
	if (grapheme.includes(KEYCAP)) return true;
	if (!EXTENDED_PICTOGRAPHIC.test(grapheme)) return false;
	return EMOJI_PRESENTATION.test(grapheme) || grapheme.includes(VS16) || EMOJI_MODIFIER.test(grapheme);
}

export function graphemeWidth(grapheme: string): 0 | 1 | 2 {
	if (grapheme.length === 0) return 0;
	if (CONTROL.test(grapheme)) return 0;
	if (MARK_OR_FORMAT.test(grapheme)) return 0;
	if (isEmojiWide(grapheme)) return 2;
	for (const char of grapheme) {
		const codepoint = char.codePointAt(0)!;
		if (isWideCodepoint(codepoint)) return 2;
	}
	return 1;
}

export function visibleWidth(text: string): number {
	let width = 0;
	for (const grapheme of graphemes(text)) width += graphemeWidth(grapheme);
	return width;
}

/** Largest prefix whose visible width fits `maxWidth`; wide graphemes are never split. */
export function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let width = 0;
	let result = "";
	for (const grapheme of graphemes(text)) {
		const next = graphemeWidth(grapheme);
		if (next > 0 && width + next > maxWidth) break;
		if (CONTROL.test(grapheme)) continue;
		width += next;
		result += grapheme;
	}
	return result;
}
