import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

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

export function createEditor(tui: TUI, onSubmit: (text: string) => void): Editor {
	const editor = new Editor(tui, theme, { paddingX: 1 });
	editor.onSubmit = onSubmit;
	return editor;
}
