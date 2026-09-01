import type { InputCompletionItem, InputCompletionSuggestions } from "@myh/protocol";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

export interface TuiInputCompletionSource {
	getSuggestions(
		input: string,
		cursor: number,
		options?: { signal?: AbortSignal; force?: boolean },
	): InputCompletionSuggestions | null | Promise<InputCompletionSuggestions | null>;
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number };
	isFileContext?(input: string, cursor: number): boolean;
}

/** Adapt the core completion contract to pi-tui's line-based editor API. */
export function createInputAutocompleteProvider(source: TuiInputCompletionSource): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const input = lines.join("\n");
			const cursor = toOffset(lines, cursorLine, cursorCol);
			return source.getSuggestions(input, cursor, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const input = lines.join("\n");
			const cursor = toOffset(lines, cursorLine, cursorCol);
			const result = source.applyCompletion(input, cursor, item, prefix);
			const nextLines = result.input.split("\n");
			const position = fromOffset(nextLines, result.cursor);
			return { lines: nextLines, cursorLine: position.line, cursorCol: position.col };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const input = lines.join("\n");
			const cursor = toOffset(lines, cursorLine, cursorCol);
			return source.isFileContext?.(input, cursor) ?? true;
		},
	};
}

export const createAutocompleteProvider = createInputAutocompleteProvider;

function toOffset(lines: readonly string[], line: number, col: number): number {
	const safeLine = Math.max(0, Math.min(lines.length - 1, Math.floor(line)));
	const safeCol = Math.max(0, Math.min((lines[safeLine] ?? "").length, Math.floor(col)));
	let offset = safeCol;
	for (let index = 0; index < safeLine; index++) offset += (lines[index] ?? "").length + 1;
	return offset;
}

function fromOffset(lines: readonly string[], offset: number): { line: number; col: number } {
	let remaining = Math.max(0, Math.min(offset, lines.join("\n").length));
	for (let line = 0; line < lines.length; line++) {
		const length = (lines[line] ?? "").length;
		if (remaining <= length || line === lines.length - 1) return { line, col: Math.min(remaining, length) };
		remaining -= length + 1;
	}
	return { line: 0, col: 0 };
}
