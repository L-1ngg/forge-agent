import { graphemes } from "./width.ts";

/**
 * Self-owned editor state (phase 2.2 B2). Grapheme buffer, explicit newlines,
 * cursor in grapheme units. No undo stack, no multi-cursor in this version.
 * Bracketed paste inserts text verbatim — newlines in pastes never submit.
 */
export interface EditorState {
	lines: string[];
	cursorLine: number;
	/** Grapheme index into lines[cursorLine]. */
	cursorColumn: number;
}

export function createEditor(): EditorState {
	return { lines: [""], cursorLine: 0, cursorColumn: 0 };
}

export function editorText(state: EditorState): string {
	return state.lines.join("\n");
}

export function isEditorEmpty(state: EditorState): boolean {
	return state.lines.length === 1 && state.lines[0] === "";
}

function lineGraphemes(state: EditorState, line: number): string[] {
	return graphemes(state.lines[line] ?? "");
}

export function insertText(state: EditorState, text: string): void {
	const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const parts = normalized.split("\n");
	const current = lineGraphemes(state, state.cursorLine);
	const before = current.slice(0, state.cursorColumn).join("");
	const after = current.slice(state.cursorColumn).join("");
	if (parts.length === 1) {
		state.lines[state.cursorLine] = before + parts[0] + after;
		state.cursorColumn += graphemes(parts[0]!).length;
		return;
	}
	const newLines = [before + parts[0]!, ...parts.slice(1, -1), parts.at(-1)! + after];
	state.lines.splice(state.cursorLine, 1, ...newLines);
	state.cursorLine += newLines.length - 1;
	state.cursorColumn = graphemes(parts.at(-1)!).length;
}

export function insertNewline(state: EditorState): void {
	insertText(state, "\n");
}

export function backspace(state: EditorState): void {
	if (state.cursorColumn > 0) {
		const current = lineGraphemes(state, state.cursorLine);
		current.splice(state.cursorColumn - 1, 1);
		state.lines[state.cursorLine] = current.join("");
		state.cursorColumn -= 1;
		return;
	}
	if (state.cursorLine > 0) {
		const previousLength = lineGraphemes(state, state.cursorLine - 1).length;
		state.lines[state.cursorLine - 1] = state.lines[state.cursorLine - 1]! + state.lines[state.cursorLine]!;
		state.lines.splice(state.cursorLine, 1);
		state.cursorLine -= 1;
		state.cursorColumn = previousLength;
	}
}

export function moveLeft(state: EditorState): void {
	if (state.cursorColumn > 0) {
		state.cursorColumn -= 1;
	} else if (state.cursorLine > 0) {
		state.cursorLine -= 1;
		state.cursorColumn = lineGraphemes(state, state.cursorLine).length;
	}
}

export function moveRight(state: EditorState): void {
	if (state.cursorColumn < lineGraphemes(state, state.cursorLine).length) {
		state.cursorColumn += 1;
	} else if (state.cursorLine < state.lines.length - 1) {
		state.cursorLine += 1;
		state.cursorColumn = 0;
	}
}

export function moveUp(state: EditorState): void {
	if (state.cursorLine === 0) return;
	state.cursorLine -= 1;
	state.cursorColumn = Math.min(state.cursorColumn, lineGraphemes(state, state.cursorLine).length);
}

export function moveDown(state: EditorState): void {
	if (state.cursorLine >= state.lines.length - 1) return;
	state.cursorLine += 1;
	state.cursorColumn = Math.min(state.cursorColumn, lineGraphemes(state, state.cursorLine).length);
}

export function moveHome(state: EditorState): void {
	state.cursorColumn = 0;
}

export function moveEnd(state: EditorState): void {
	state.cursorColumn = lineGraphemes(state, state.cursorLine).length;
}

/** Return the draft and reset the editor. */
export function submitEditor(state: EditorState): string {
	const text = editorText(state);
	state.lines = [""];
	state.cursorLine = 0;
	state.cursorColumn = 0;
	return text;
}
