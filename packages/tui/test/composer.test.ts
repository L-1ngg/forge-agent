import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { Composer, createEditor, createSemanticTheme, createTuiHost, frameFromLines } from "../src/index.ts";

test("composer renders the upstream boxed prompt with a bottom model caption", () => {
	const { editor, composer } = makeComposer({ getInfo: () => ({ modelName: "grok-4.6" }) });
	editor.focused = true;
	const lines = composer.render(40).map(stripTerminalSequences);

	expect(lines).toHaveLength(3);
	expect(lines[0]).toMatch(/^╭─+─╮$/);
	expect(lines[1]).toMatch(/^│ ❯ +│$/);
	expect(lines[1]?.at(-2)).toBe(" ");
	expect(lines[2]).toContain("grok-4.6");
	expect(lines[2]?.startsWith("╰")).toBe(true);
	expect(lines[2]?.endsWith("╯")).toBe(true);
	for (const line of lines) expect(visibleWidth(line)).toBe(40);
});

test("composer keeps focused input empty and shows placeholder only when unfocused", () => {
	const { editor, composer } = makeComposer();
	editor.focused = true;
	const focused = stripTerminalSequences(composer.render(32)[1] ?? "");
	expect(focused).toContain("❯");
	expect(focused).not.toContain("Build anything");

	editor.focused = false;
	const unfocused = stripTerminalSequences(composer.render(32)[1] ?? "");
	expect(unfocused).toContain("Build anything");
	for (const line of composer.render(32)) expect(visibleWidth(line)).toBe(32);
});

test("composer preserves editor wrapping, continuation indentation, and wide graphemes", () => {
	const { editor, composer } = makeComposer({ getInfo: () => ({ modelName: "grok" }) });
	editor.focused = true;
	editor.setText("你好🙂 this prompt wraps across the box");
	const lines = composer.render(24).map(stripTerminalSequences);

	expect(lines.length).toBeGreaterThan(3);
	expect(lines[1]).toContain("❯ 你好🙂");
	expect(lines.slice(2, -1).some((line) => line.startsWith("│   "))).toBe(true);
	expect(lines.at(-1)).toContain("grok");
	for (const line of lines) expect(visibleWidth(line)).toBe(24);
});

test("composer keeps title and multiline caption inside the border", () => {
	const { composer } = makeComposer({
		getInfo: () => ({ modelName: "grok-4.6", flags: ["plan"], multiline: true }),
		title: "release session",
	});
	const lines = composer.render(36).map(stripTerminalSequences);

	expect(lines[0]).toContain("release session");
	expect(lines.at(-1)).toContain("grok-4.6 · plan");
	expect(lines.at(-1)).toContain("multiline");
	for (const line of lines) expect(visibleWidth(line)).toBe(36);
});

test("composer preserves a focused cursor marker and rejects undersized boxes", () => {
	const { editor, composer } = makeComposer();
	editor.focused = true;
	editor.setText("draft");
	expect(composer.render(40).some((line) => line.includes("\u001b_pi:c\u0007"))).toBe(true);
	expect(composer.render(3)).toEqual([]);
});

test("composer reports the boxed prompt height and caps it without dropping the bottom chrome", () => {
	const { editor, composer } = makeComposer({ getInfo: () => ({ modelName: "grok" }) });
	editor.focused = true;
	editor.setText("one\ntwo\nthree\nfour\nfive");
	const desired = composer.desiredHeight(24, 20);
	expect(desired).toBeGreaterThan(3);
	const fitted = composer.renderForHeight(24, 3).map(stripTerminalSequences);
	expect(fitted).toHaveLength(3);
	expect(fitted[0]).toMatch(/^╭─+╮$/);
	expect(fitted.at(-1)).toContain("grok");
});

test("composer uses the upstream focused and unfocused border colors", () => {
	const { editor, composer } = makeComposer();
	editor.focused = true;
	const focused = frameFromLines(composer.render(40), 40, 3);
	expect(focused.cells[0]?.[1]?.foreground).toEqual({ kind: "rgb", r: 80, g: 80, b: 88 });

	editor.focused = false;
	const unfocused = frameFromLines(composer.render(40), 40, 3);
	expect(unfocused.cells[0]?.[1]?.foreground).toEqual({ kind: "rgb", r: 50, g: 50, b: 55 });
});

function makeComposer(options: ConstructorParameters<typeof Composer>[2] = {}): { editor: ReturnType<typeof createEditor>; composer: Composer } {
	const terminal: Terminal = {
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start(): void {},
		stop(): void {},
		async drainInput(): Promise<void> {},
		write(): void {},
		moveBy(): void {},
		hideCursor(): void {},
		showCursor(): void {},
		clearLine(): void {},
		clearFromCursor(): void {},
		clearScreen(): void {},
		setTitle(): void {},
		setProgress(): void {},
	};
	const tui = createTuiHost({ terminal, mode: "main" });
	const editor = createEditor(tui, () => undefined, { theme: createSemanticTheme() });
	return { editor, composer: new Composer(editor, createSemanticTheme(), options) };
}
