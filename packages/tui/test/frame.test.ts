import { expect, test } from "bun:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { compareEnvironmentManifests, diffFrames, diffRgba, frameFromLines, type ReferenceEnvironmentManifest } from "../src/frame.ts";
import { parseTerminalFrame, serializeTerminalFrame } from "../src/frame-artifacts.ts";
import { canvasStyle } from "../src/theme.ts";
import { restoreCanvasSgr } from "../src/screen.ts";
import { createSemanticTheme } from "../src/theme.ts";

test("frame parser preserves glyph, style, resets, and full-width continuation cells", () => {
	const frame = frameFromLines(["\u001b[38;2;187;154;247;48;5;236;1m你e\u0301\u001b[22;39;49m!"], 8, 1);
	expect(frame.cells[0]?.[0]).toMatchObject({
		grapheme: "你",
		width: 2,
		foreground: { kind: "rgb", r: 187, g: 154, b: 247 },
		background: { kind: "indexed", index: 236 },
		attributes: { bold: true },
	});
	expect(frame.cells[0]?.[1]).toMatchObject({ grapheme: "", width: 0 });
	expect(frame.cells[0]?.[2]).toMatchObject({ grapheme: "e\u0301", width: 1, attributes: { bold: true } });
	expect(frame.cells[0]?.[3]).toMatchObject({
		grapheme: "!",
		foreground: { kind: "default" },
		background: { kind: "default" },
		attributes: { bold: false },
	});
});

test("frame diff is exact for glyph, color, background, and attributes", () => {
	const reference = frameFromLines(["\u001b[38;2;1;2;3;48;2;4;5;6;1mA"], 2, 1);
	expect(diffFrames(reference, frameFromLines(["\u001b[38;2;1;2;3;48;2;4;5;6;1mA"], 2, 1))).toMatchObject({ equal: true, differingCells: 0 });
	for (const candidate of [
		frameFromLines(["\u001b[38;2;1;2;3;48;2;4;5;6;1mB"], 2, 1),
		frameFromLines(["\u001b[38;2;1;2;4;48;2;4;5;6;1mA"], 2, 1),
		frameFromLines(["\u001b[38;2;1;2;3;48;2;4;5;7;1mA"], 2, 1),
		frameFromLines(["\u001b[38;2;1;2;3;48;2;4;5;6mA"], 2, 1),
	]) expect(diffFrames(reference, candidate)).toMatchObject({ equal: false, differingCells: 1 });
});

test("serialized frames compare equal after stable JSON reorders object keys", () => {
	const frame = frameFromLines(["\u001b[38;2;1;2;3;48;5;4;1mA"], 2, 1);
	const parsed = parseTerminalFrame(serializeTerminalFrame(frame));
	expect(diffFrames(frame, parsed)).toMatchObject({ equal: true, differingCells: 0 });
});

test("unpainted and reset cells keep the terminal default background", () => {
	const frame = frameFromLines(["\u001b[48;2;36;36;36m  \u001b[49m "], 5, 1);
	expect(frame.cells[0]?.[1]?.background).toEqual({ kind: "rgb", r: 36, g: 36, b: 36 });
	expect(frame.cells[0]?.[2]?.background).toEqual({ kind: "default" });
	expect(frame.cells[0]?.[4]?.background).toEqual({ kind: "default" });
});

test("canvas style restores base foreground and background after child resets", () => {
	const theme = {
		base: (value: string) => `\u001b[48;2;20;20;20m${value}\u001b[49m`,
		status: (value: string) => `\u001b[38;2;225;225;225m${value}\u001b[39m`,
	} as Parameters<typeof canvasStyle>[0];
	const line = restoreCanvasSgr(canvasStyle(theme, `\u001b[38;2;122;162;247mctx\u001b[39m tail`), (value) => canvasStyle(theme, value));
	const frame = frameFromLines([line], 10, 1);
	expect(frame.cells[0]?.[0]?.foreground).toEqual({ kind: "rgb", r: 122, g: 162, b: 247 });
	expect(frame.cells[0]?.[3]?.foreground).toEqual({ kind: "rgb", r: 225, g: 225, b: 225 });
	expect(frame.cells[0]?.[0]?.background).toEqual({ kind: "rgb", r: 20, g: 20, b: 20 });
	expect(frame.cells[0]?.[4]?.background).toEqual({ kind: "rgb", r: 20, g: 20, b: 20 });
});

test("nested surface background survives a full child reset", () => {
	const theme = createSemanticTheme();
	const line = restoreCanvasSgr(canvasStyle(theme, theme.surface(`before\u001b[0mafter`)), (value) => canvasStyle(theme, value));
	const frame = frameFromLines([line], 11, 1);
	for (const cell of frame.cells[0]?.slice(0, 11) ?? []) expect(cell.background).toEqual({ kind: "rgb", r: 36, g: 36, b: 36 });
});

test("private and non-SGR CSI controls never become transcript glyphs", () => {
	const frame = frameFromLines(["\u001b[?25l\u001b[2Khello\u001b[?25h"], 8, 1);
	expect(frame.cells[0]?.slice(0, 5).map((cell) => cell.grapheme)).toEqual(["h", "e", "l", "l", "o"]);
});

test("frame capture preserves a focused editor cursor marker and diffs cursor movement", () => {
	const withCursor = frameFromLines([`ab${CURSOR_MARKER}\u001b[7m \u001b[0m`], 6, 1);
	const movedCursor = frameFromLines([`a${CURSOR_MARKER}\u001b[7mb\u001b[0m`], 6, 1);
		const { cursor: _cursor, ...withoutCursor } = withCursor;
	expect(withCursor.cursor).toEqual({ x: 2, y: 0, visible: true, shape: "block" });
	expect(diffFrames(withCursor, withoutCursor)).toMatchObject({ equal: false, differingCells: 0, cursorMismatch: true });
	expect(diffFrames(withCursor, movedCursor)).toMatchObject({ equal: false, cursorMismatch: true });
});

test("RGBA diff rejects one changed channel without tolerance", () => {
	const reference = { width: 1, height: 1, pixels: Uint8Array.of(20, 20, 20, 255) };
	expect(diffRgba(reference, { width: 1, height: 1, pixels: Uint8Array.of(20, 20, 20, 255) })).toEqual({
		equal: true,
		dimensionMismatch: false,
		differingPixels: 0,
		maxChannelDelta: 0,
	});
	expect(diffRgba(reference, { width: 1, height: 1, pixels: Uint8Array.of(20, 20, 21, 255) })).toEqual({
		equal: false,
		dimensionMismatch: false,
		differingPixels: 1,
		maxChannelDelta: 1,
	});
});

test("manifest comparison reports the exact environment field that drifted", () => {
	const manifest = referenceManifest();
	const changed = structuredClone(manifest);
	changed.font.sha256 = "different";
	expect(compareEnvironmentManifests(manifest, structuredClone(manifest))).toEqual({ status: "match" });
	expect(compareEnvironmentManifests(manifest, changed)).toEqual({ status: "environment-mismatch", fields: ["font.sha256"] });
});

function referenceManifest(): ReferenceEnvironmentManifest {
	return {
		status: "locked",
		terminal: { name: "terminal", version: "1", renderer: "gpu" },
		os: { name: "linux", version: "1", displayServer: "wayland" },
		font: { path: "/font.ttf", sha256: "font", family: "Mono", size: 12, lineHeight: 14, weight: 400, hinting: "full", antialiasing: "gray" },
		display: { dpi: 96, scale: 1, contentWidthPx: 800, contentHeightPx: 480, cellWidthPx: 10, cellHeightPx: 20, colorProfile: "sRGB" },
		terminalTheme: { name: "GrokNight", defaultForeground: "#e1e1e1", defaultBackground: "#141414", ansi16Sha256: "16", ansi256Sha256: "256", truecolor: true },
		viewport: { columns: 80, rows: 24 },
		runtime: { term: "xterm-256color", colorTerm: "truecolor", locale: "en_US.UTF-8", unicodeWidthPolicy: "pi-tui-0.84.4", timezone: "UTC" },
		cursor: { visible: false, shape: "block", blink: false, phase: 0 },
		determinism: { clock: "2026-09-02T00:00:00Z", animationFrame: 0, randomSeed: 1, fixture: "basic" },
	};
}
