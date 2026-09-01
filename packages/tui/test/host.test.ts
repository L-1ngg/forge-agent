import { expect, test } from "bun:test";
import { Text, type Terminal } from "@earendil-works/pi-tui";
import { TuiHostController, createTuiHost } from "../src/index.ts";

test("main and alt hosts render the same component tree", () => {
	const terminal = new FakeTerminal();
	const main = createTuiHost({ terminal, mode: "main" });
	const alt = createTuiHost({ terminal, mode: "alt", altScreen: { mouse: false } });
	const mainText = new Text("same tree");
	const altText = new Text("same tree");
	main.addChild(mainText);
	alt.addChild(altText);
	expect(main.render(40)).toEqual(alt.render(40));
	expect(main.mode).toBe("regular");
	expect(alt.mode).toBe("fullscreen");
});

test("host controller preserves mounted components while switching", () => {
	const terminal = new FakeTerminal();
	const controller = new TuiHostController({ terminal, mode: "main", altScreen: { mouse: false } });
	const component = new Text("preserved");
	controller.mount(component);
	controller.switchMode("alt");
	expect(controller.mode).toBe("alt");
	expect(controller.children).toEqual([component]);
	expect(controller.screen.render(40).join("\n")).toContain("preserved");
});

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
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
}
