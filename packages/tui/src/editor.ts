import { Editor, type AutocompleteProvider, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { defaultTheme, type SemanticTheme } from "./theme.ts";

export interface CreateEditorOptions {
	autocompleteProvider?: AutocompleteProvider;
	theme?: SemanticTheme;
}

export function createEditor(tui: TUI, onSubmit: (text: string) => void, options: CreateEditorOptions = {}): Editor {
	const theme = options.theme ?? defaultTheme;
	const editorTheme: EditorTheme = {
		borderColor: (value) => theme.muted(value),
		selectList: {
			selectedPrefix: (value) => theme.accent_execute(value),
			selectedText: (value) => theme.status(value),
			description: (value) => theme.muted(value),
			scrollInfo: (value) => theme.muted(value),
			noMatch: (value) => theme.muted(value),
		},
	};
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	editor.onSubmit = onSubmit;
	if (options.autocompleteProvider) editor.setAutocompleteProvider(options.autocompleteProvider);
	return editor;
}
