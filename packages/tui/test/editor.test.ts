import { expect, test } from "bun:test";
import {
	backspace,
	createEditor,
	editorText,
	insertNewline,
	insertText,
	isEditorEmpty,
	moveDown,
	moveEnd,
	moveHome,
	moveLeft,
	moveRight,
	moveUp,
	submitEditor,
} from "../src/index.ts";

test("insert, submit and reset", () => {
	const editor = createEditor();
	expect(isEditorEmpty(editor)).toBe(true);
	insertText(editor, "hello");
	expect(editorText(editor)).toBe("hello");
	expect(submitEditor(editor)).toBe("hello");
	expect(isEditorEmpty(editor)).toBe(true);
});

test("CJK and emoji insert/backspace keep graphemes whole", () => {
	const editor = createEditor();
	insertText(editor, "你好😀");
	expect(editorText(editor)).toBe("你好😀");
	backspace(editor);
	expect(editorText(editor)).toBe("你好");
	backspace(editor);
	backspace(editor);
	expect(isEditorEmpty(editor)).toBe(true);
	backspace(editor); // no-op at the start
	expect(isEditorEmpty(editor)).toBe(true);
});

test("multiline insert and newline splitting", () => {
	const editor = createEditor();
	insertText(editor, "line1\nline2\r\nline3");
	expect(editor.lines).toEqual(["line1", "line2", "line3"]);
	expect(editor.cursorLine).toBe(2);
	expect(editor.cursorColumn).toBe(5);
	insertNewline(editor);
	expect(editorText(editor)).toBe("line1\nline2\nline3\n");
	expect(editor.lines).toEqual(["line1", "line2", "line3", ""]);
});

test("backspace at line start joins with the previous line", () => {
	const editor = createEditor();
	insertText(editor, "ab\ncd");
	moveHome(editor);
	backspace(editor);
	expect(editorText(editor)).toBe("abcd");
	expect(editor.cursorLine).toBe(0);
	expect(editor.cursorColumn).toBe(2);
});

test("cursor moves in grapheme steps across lines", () => {
	const editor = createEditor();
	insertText(editor, "你好\n世界");
	moveLeft(editor);
	expect([editor.cursorLine, editor.cursorColumn]).toEqual([1, 1]);
	moveLeft(editor);
	moveLeft(editor); // wraps to end of line 0
	expect([editor.cursorLine, editor.cursorColumn]).toEqual([0, 2]);
	moveRight(editor);
	expect([editor.cursorLine, editor.cursorColumn]).toEqual([1, 0]);
	moveUp(editor);
	moveDown(editor);
	moveEnd(editor);
	expect([editor.cursorLine, editor.cursorColumn]).toEqual([1, 2]);
});

test("insert in the middle respects the cursor", () => {
	const editor = createEditor();
	insertText(editor, "ac");
	moveLeft(editor);
	insertText(editor, "b");
	expect(editorText(editor)).toBe("abc");
	expect(editor.cursorColumn).toBe(2);
});

test("a combining mark arriving separately keeps the cursor inside the grapheme buffer", () => {
	const editor = createEditor();
	insertText(editor, "e");
	insertText(editor, "\u0301");
	expect(editor.cursorColumn).toBe(1);
	backspace(editor);
	expect(editorText(editor)).toBe("");
});
