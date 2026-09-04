import { expect, test } from "bun:test";
import { createEditor, createFrame, frameToText, insertText, paintComposer, createTheme, wrapDraft, type EditorState } from "../src/index.ts";

const theme = createTheme({ mode: "truecolor" });

function paint(draft: EditorState, width = 40, height = 5, caption = "faux-1") {
	const frame = createFrame(width, 10);
	paintComposer({ frame, x: 0, y: 2, width, height, draft, theme, caption, placeholder: "Type a message", compact: false });
	return frame;
}

test("rounded border, prompt prefix and model caption", () => {
	const draft = createEditor();
	const frame = paint(draft);
	const lines = frameToText(frame).split("\n");
	expect(lines[2]).toMatch(/^╭─+╮$/);
	expect(lines[3]).toMatch(/^│ ❯ Type a message/); // placeholder while empty
	expect(lines[6]).toContain("╰");
	expect(lines[6]).toContain(" faux-1 ");
	expect(lines[6]).toContain("╯");
	expect(frame.cursor).toMatchObject({ y: 3, visible: true });
});

test("draft text paints after the prefix and the cursor follows", () => {
	const draft = createEditor();
	insertText(draft, "hi");
	const frame = paint(draft);
	expect(frameToText(frame).split("\n")[3]).toMatch(/^│ ❯ hi/);
	expect(frame.cursor).toMatchObject({ x: 2 + 2 + 2, y: 3 }); // border+pad, prefix, 2 chars
});

test("CJK draft keeps the cursor on cell boundaries", () => {
	const draft = createEditor();
	insertText(draft, "你好");
	const frame = paint(draft);
	expect(frameToText(frame).split("\n")[3]).toContain("你好");
	expect(frame.cursor!.x).toBe(2 + 2 + 4); // two wide graphemes = 4 columns
});

test("long drafts wrap and scroll so the cursor row stays visible", () => {
	const draft = createEditor();
	insertText(draft, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 60 chars, wraps at 34
	const frame = paint(draft, 40, 4);
	const cursor = frame.cursor!;
	expect(cursor.y).toBeGreaterThanOrEqual(3);
	expect(cursor.y).toBeLessThanOrEqual(5); // within the 2 visible content rows
});

test("wrapDraft puts a wrap-boundary cursor on a phantom row", () => {
	const draft = createEditor();
	insertText(draft, "abcd");
	const wrapped = wrapDraft(draft, 4); // exactly full
	expect(wrapped.cursorX).toBe(0);
	expect(wrapped.cursorY).toBe(1);
});
