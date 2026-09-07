import { expect, test } from "bun:test";
import { createFrame, createTheme, frameToText, paintWelcome } from "../src/index.ts";

test("narrow welcome keeps the complete brand and omits explanatory copy", () => {
	const frame = createFrame(60, 12);
	paintWelcome(frame, 0, 10, { cwd: "/tmp/proj", homeDir: "/tmp", model: "faux-1" }, createTheme({ mode: "truecolor" }));
	const text = frameToText(frame);
	expect(text).toContain("forge-agent");
	expect(text).not.toContain("/ for commands");
	expect(text).not.toContain("faux-1");
});
