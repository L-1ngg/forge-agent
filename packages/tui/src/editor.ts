import { Editor, type AutocompleteProvider, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const theme: EditorTheme = {
	borderColor: (value) => value,
	selectList: {
		selectedPrefix: (value) => value,
		selectedText: (value) => value,
		description: (value) => value,
		scrollInfo: (value) => value,
		noMatch: (value) => value,
	},
};

export interface CreateEditorOptions {
	autocompleteProvider?: AutocompleteProvider;
}

export function createEditor(tui: TUI, onSubmit: (text: string) => void, options: CreateEditorOptions = {}): Editor {
	const editor = new Editor(tui, theme, { paddingX: 1 });
	editor.onSubmit = onSubmit;
	if (options.autocompleteProvider) editor.setAutocompleteProvider(options.autocompleteProvider);
	return editor;
}
