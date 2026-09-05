import { expect, test } from "bun:test";
import { createFrame, createTheme, frameToText, paintWelcome } from "../src/index.ts";

test("welcome paints a title and the command hints", () => {
	const frame = createFrame(60, 12);
	paintWelcome(frame, 0, 10, { cwd: "/tmp/proj", homeDir: "/tmp", model: "faux-1" }, createTheme({ mode: "truecolor" }));
	const text = frameToText(frame);
	expect(text).toContain("Forge Agent");
	expect(text).toContain("/ for commands");
	expect(text).toContain("faux-1");
});
