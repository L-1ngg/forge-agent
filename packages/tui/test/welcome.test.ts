import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import {
	Composer,
	App,
	WelcomeScreen,
	create256ColorTheme,
	createEditor,
	createTuiHost,
	diffFrames,
	frameFromLines,
	nearestIndexed,
	styledJsonToIndexedFrame,
	type WelcomeScreenOptions,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "upstream");

test("welcome reproduces the upstream 100x32 ANSI256 cell grid as a diagnostic", async () => {
	const { welcome } = makeWelcome(100, 32, { animationSeconds: 0 });
	const reference = styledJsonToIndexedFrame(await readFile(join(FIXTURES, "welcome-100x32.styled.json"), "utf8"));
	const candidate = frameWithoutHardwareCursor(welcome.render(100), 100, 32);

	expect(diffFrames(reference, candidate)).toMatchObject({ equal: true, differingCells: 0, cursorMismatch: false });
	expect(welcome.plan).toEqual({
		columns: 100,
		rows: 32,
		compact: false,
		hero: { x: 3, y: 6, width: 94, height: 11 },
		prompt: { x: 2, y: 26, width: 96, height: 3 },
		locationRow: 1,
		statusRow: 30,
	});
});

test("welcome fixes the upstream shimmer phase for the 90x28 ANSI256 diagnostic", async () => {
	const { welcome } = makeWelcome(90, 28, { animationSeconds: 0.258 });
	const reference = styledJsonToIndexedFrame(await readFile(join(FIXTURES, "welcome-90x28.styled.json"), "utf8"));
	const first = frameWithoutHardwareCursor(welcome.render(90), 90, 28);
	const second = frameWithoutHardwareCursor(welcome.render(90), 90, 28);

	expect(diffFrames(reference, first)).toMatchObject({ equal: true, differingCells: 0, cursorMismatch: false });
	expect(diffFrames(first, second)).toMatchObject({ equal: true, differingCells: 0, cursorMismatch: false });
	expect(welcome.plan?.hero).toEqual({ x: 3, y: 5, width: 84, height: 11 });
});

test("welcome keeps the measured logo, menu, prompt, and status geometry", () => {
	const { welcome } = makeWelcome(100, 32, { animationSeconds: 0 });
	const lines = welcome.render(100);
	const frame = frameFromLines(lines, 100, 32);

	expect(lines).toHaveLength(32);
	for (const line of lines) expect(visibleWidth(stripTerminalSequences(line))).toBe(100);
	expect(frame.cells[1]?.[2]?.grapheme).toBe("~");
	expect(frame.cells[6]?.[3]?.grapheme).toBe("╭");
	expect(frame.cells[6]?.[96]?.grapheme).toBe("╮");
	expect(frame.cells[8]?.[6]?.grapheme).toBe("⠀");
	expect(frame.cells[8]?.[23]?.grapheme).toBe("G");
	expect(frame.cells[26]?.[2]?.grapheme).toBe("╭");
	expect(frame.cells[27]?.[4]?.grapheme).toBe("❯");
	expect(frame.cells[28]?.slice(85, 95).map((cell) => cell.grapheme).join("")).toBe("test-model");
	expect(frame.cells[30]?.map((cell) => cell.grapheme).join("")).toContain("Logged in with API key");
});

test("welcome switches between composer and menu and paints the selected row", () => {
	const { welcome, editor } = makeWelcome(100, 32);

	welcome.handleInput("\u001b");
	expect(welcome.focused).toBe(false);
	welcome.handleInput("\u001b[B");
	expect(welcome.selectedIndex).toBe(0);
	const selected = frameFromLines(welcome.render(100), 100, 32);
	const selectedRow = (welcome.plan?.hero?.y ?? 0) + 5;
	expect(selected.cells[selectedRow]?.[40]?.background).toEqual({ kind: "indexed", index: nearestIndexed(36, 36, 36) });

	welcome.handleInput("x");
	expect(welcome.focused).toBe(true);
	expect(welcome.selectedIndex).toBeUndefined();
	expect(editor.getText()).toBe("x");
});

test("welcome routes global shortcuts and menu activation", () => {
	const calls: string[] = [];
	const { welcome } = makeWelcome(100, 32, {
		onNewWorktree: () => calls.push("new"),
		onResume: () => calls.push("resume"),
		onChangelog: () => calls.push("changelog"),
		onQuit: () => calls.push("quit"),
	});

	welcome.handleInput("\u0017");
	welcome.handleInput("\u001bOR");
	welcome.handleInput("\u0011");
	welcome.handleInput("\u001b");
	welcome.handleInput("\u001b[B");
	welcome.handleInput("\u001b[B");
	welcome.handleInput("\u001b[B");
	welcome.handleInput("\r");

	expect(calls).toEqual(["new", "resume", "quit", "changelog"]);
});

test("welcome stays inside compact and very short viewports", () => {
	for (const [columns, rows] of [[16, 8], [40, 9], [3, 2]] as const) {
		const { welcome } = makeWelcome(columns, rows);
		const lines = welcome.render(columns);
		expect(lines).toHaveLength(rows);
		for (const line of lines) expect(visibleWidth(stripTerminalSequences(line))).toBe(columns);
		expect(welcome.plan?.hero).toBeUndefined();
		expect(welcome.plan?.prompt.y).toBeGreaterThanOrEqual(0);
		expect((welcome.plan?.prompt.y ?? 0) + (welcome.plan?.prompt.height ?? 0)).toBeLessThanOrEqual(rows);
	}
});

test("App mounts welcome only when requested and submits the first prompt once", async () => {
	const terminal = new WelcomeTerminal(100, 32);
	const submitted: string[] = [];
	const app = new App({
		terminal,
		showWelcome: true,
		cwd: "/home/user/project",
		homeDir: "/home/user",
		getStatus: () => ({ model: "test-model" }),
		port: {
			async *runTurn(input: string) {
				submitted.push(input);
			},
			steer() {},
			followUp() {},
			abort() {},
		},
	});

	await app.start();
	const welcomeFrame = stripTerminalSequences(app.tui.render(100).join("\n"));
	expect(welcomeFrame).toContain("Grok Build");
	expect(welcomeFrame).toContain("~/project");
	terminal.send("build it");
	terminal.send("\r");
	await Bun.sleep(0);

	expect(submitted).toEqual(["build it"]);
	expect(stripTerminalSequences(app.tui.render(100).join("\n"))).not.toContain("Grok Build");
	expect(app.editor.getText()).toBe("");
	await app.stop();
});

test("App keeps the existing agent screen as the default", async () => {
	const app = new App({
		terminal: new WelcomeTerminal(100, 32),
		port: {
			async *runTurn() {},
			steer() {},
			followUp() {},
			abort() {},
		},
	});

	expect(app.welcome).toBeUndefined();
	expect(stripTerminalSequences(app.tui.render(100).join("\n"))).not.toContain("Grok Build");
	await app.stop();
});

function makeWelcome(columns: number, rows: number, overrides: Partial<WelcomeScreenOptions> = {}): {
	welcome: WelcomeScreen;
	editor: ReturnType<typeof createEditor>;
} {
	const terminal = new WelcomeTerminal(columns, rows);
	const tui = createTuiHost({ terminal, mode: "main" });
	const theme = create256ColorTheme();
	const editor = createEditor(tui, () => undefined, { theme });
	editor.focused = true;
	const composer = new Composer(editor, theme, { getInfo: () => ({ modelName: "test-model" }) });
	const welcome = new WelcomeScreen({
		tui,
		composer,
		theme,
		version: "1.0.12",
		location: "~",
		loggedIn: true,
		animationColorMode: "256",
		...overrides,
	});
	return { welcome, editor };
}

function frameWithoutHardwareCursor(lines: readonly string[], columns: number, rows: number) {
	const frame = frameFromLines(lines, columns, rows);
	delete frame.cursor;
	return frame;
}

class WelcomeTerminal implements Terminal {
	kittyProtocolActive = false;
	private input?: (data: string) => void;

	constructor(public columns: number, public rows: number) {}

	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	send(data: string): void {
		this.input?.(data);
	}
}
