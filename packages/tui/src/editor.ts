import { Editor, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type AutocompleteProvider, type EditorTheme, type Focusable, type TUI, type Component } from "@earendil-works/pi-tui";
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

export interface ComposerInfo {
	/** Model label shown in the bottom chrome. */
	modelName?: string;
	/** Mode labels joined with the upstream ` · ` separator. */
	flags?: readonly string[];
	/** Right-aligned multiline indicator. */
	multiline?: boolean;
}

export interface ComposerOptions {
	getInfo?: () => ComposerInfo | undefined;
	placeholder?: string;
	/** Agent view uses symmetric two-cell chrome padding. */
	chromePadLeft?: number;
	chromePadRight?: number;
	compact?: boolean;
	/** Optional session title inlined in the top border. */
	title?: string | (() => string | undefined);
}

/**
 * TypeScript counterpart of grok-build's PromptWidget chrome.
 *
 * The pi-tui Editor remains the source of truth for editing, wrapping and
 * cursor markers. Composer only redraws its border/padding around those rows,
 * which keeps the input behavior intact while matching the upstream prompt
 * geometry (`╭─╮`, side borders, and an info caption on `╰─╯`).
 */
export class Composer implements Component, Focusable {
	private readonly options: Required<Pick<ComposerOptions, "placeholder" | "chromePadLeft" | "chromePadRight" | "compact">> & Pick<ComposerOptions, "getInfo" | "title">;

	constructor(private readonly editor: Editor, private readonly theme: SemanticTheme = defaultTheme, options: ComposerOptions = {}) {
		this.options = {
			placeholder: options.placeholder ?? "Build anything",
			chromePadLeft: positiveInt(options.chromePadLeft, 2),
			chromePadRight: positiveInt(options.chromePadRight, 2),
			compact: options.compact ?? false,
			...(options.getInfo ? { getInfo: options.getInfo } : {}),
			...(options.title !== undefined ? { title: options.title } : {}),
		};
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 4) return [];
		const info = this.options.getInfo?.();
		const hasInfo = Boolean(info && (info.modelName?.trim() || info.flags?.some((flag) => flag.trim()) || info.multiline));
		const contentWidth = Math.max(1, safeWidth - this.options.chromePadLeft - this.options.chromePadRight);
		const textWidth = Math.max(1, contentWidth - 2);
		const editorWidth = textWidth + 2;
		const editorLines = this.editor.render(editorWidth);
		const { textLines, autocompleteLines } = splitEditorLines(editorLines, editorWidth);
		const bodyLines = textLines.length > 0 ? textLines : [""];
		const editorEmpty = this.editor.getText().length === 0;
		const title = resolveTitle(this.options.title);
		const result: string[] = [this.renderTopBorder(safeWidth, title)];
		const prefixColor = this.focused ? this.theme.accent_user : this.theme.muted;
		const prefix = backgroundize(prefixColor?.("❯ ") ?? "❯ ", this.theme);
		for (const [index, editorLine] of bodyLines.entries()) {
			const inner = normalizeEditorCursor(sliceByColumn(editorLine, 1, Math.max(1, editorWidth - 1), true));
			const content = index === 0 && editorEmpty && !this.focused ? this.renderPlaceholder(textWidth) : this.renderEditorText(inner, textWidth);
			const prefixPart = index === 0 ? prefix : backgroundize("  ", this.theme);
			const textPart = fitVisible(`${prefixPart}${content}`, contentWidth);
			result.push(this.renderSideRow(safeWidth, textPart));
		}
		if (info && hasInfo) result.push(this.renderBottomBorder(safeWidth, info));
		return [...result, ...autocompleteLines.map((line) => truncateToWidth(line, safeWidth, "", true))];
	}

	/**
	 * Height counterpart of grok-build's PromptWidget::desired_height(). The
	 * editor owns visual wrapping; Composer only adds the top chrome and the
	 * optional info divider, then applies the caller's viewport cap.
	 */
	desiredHeight(width: number, maxHeight = Number.MAX_SAFE_INTEGER): number {
		const safeMax = Number.isFinite(maxHeight) ? Math.max(0, Math.floor(maxHeight)) : Number.MAX_SAFE_INTEGER;
		if (Math.max(1, Math.floor(width)) < 4 || safeMax === 0) return 0;
		const info = this.options.getInfo?.();
		const hasInfo = Boolean(info && (info.modelName?.trim() || info.flags?.some((flag) => flag.trim()) || info.multiline));
		const contentWidth = Math.max(1, Math.floor(width) - this.options.chromePadLeft - this.options.chromePadRight);
		const editorWidth = Math.max(1, contentWidth);
		const { textLines } = splitEditorLines(this.editor.render(editorWidth), editorWidth);
		const textareaRows = Math.max(1, textLines.length);
		const total = 1 + textareaRows + (hasInfo ? 1 : 0);
		return Math.min(total, safeMax);
	}

	/** Render a prompt into an allocated row budget while preserving its chrome. */
	renderForHeight(width: number, height: number): string[] {
		const safeHeight = Math.max(0, Math.floor(height));
		if (safeHeight === 0) return [];
		const lines = this.render(width);
		if (lines.length <= safeHeight) return lines;
		const bottomIndex = lines.findIndex((line, index) => index > 0 && stripTerminalSequences(line).startsWith("╰"));
		const bodyEnd = bottomIndex >= 0 ? bottomIndex : lines.length;
		const body = lines.slice(1, bodyEnd);
		if (safeHeight === 1) return [lines[0] ?? ""];
		if (bottomIndex < 0) return [lines[0] ?? "", ...selectCursorWindow(body, safeHeight - 1)];
		const bodyBudget = safeHeight - 2;
		return [lines[0] ?? "", ...selectCursorWindow(body, bodyBudget), lines[bottomIndex] ?? ""];
	}

	handleInput(data: string): void {
		this.editor.handleInput?.(data);
	}

	 invalidate(): void {
		this.editor.invalidate();
	}

	private renderEditorText(line: string, width: number): string {
		const fitted = fitVisible(line, width);
		const text = (this.focused ? this.theme.status : this.theme.muted)(fitted);
		return backgroundize(text, this.theme);
	}

	private renderPlaceholder(width: number): string {
		const placeholder = truncateToWidth(this.options.placeholder, width, "", true);
		return backgroundize(this.theme.muted(placeholder), this.theme);
	}

	private renderSideRow(width: number, content: string): string {
		const border = this.borderColor("│");
		const leftPad = " ".repeat(Math.max(0, this.options.chromePadLeft - 1));
		const rightPad = " ".repeat(Math.max(0, this.options.chromePadRight - 1));
		const available = Math.max(0, width - 2 - leftPad.length - rightPad.length);
		const inner = fitVisible(content, available);
		const filler = " ".repeat(Math.max(0, available - visibleWidth(stripTerminalSequences(inner))));
		return `${backgroundize(border, this.theme)}${promptBlank(leftPad, this.theme)}${inner}${promptBlank(filler, this.theme)}${promptBlank(rightPad, this.theme)}${backgroundize(border, this.theme)}`;
	}

	private renderTopBorder(width: number, title: string | undefined): string {
		const borderWidth = Math.max(0, width - 2);
		const border = `╭${"─".repeat(borderWidth)}╮`;
		if (!title || width < 8) return backgroundize(this.borderColor(border), this.theme);
		const label = ` ${title.trim()} `;
		const maxLabelWidth = Math.max(0, width - 6);
		const clipped = truncateToWidth(label, maxLabelWidth, "", false);
		const labelWidth = visibleWidth(stripTerminalSequences(clipped));
		const labelStart = Math.max(1, width - 3 - labelWidth);
		const before = "─".repeat(Math.max(0, labelStart - 1));
		const after = "─".repeat(Math.max(0, width - 1 - (labelStart + labelWidth)));
		return `${backgroundize(this.borderColor(`╭${before}`), this.theme)}${backgroundize(this.borderColor(clipped), this.theme)}${backgroundize(this.borderColor(`${after}╮`), this.theme)}`;
	}

	private renderBottomBorder(width: number, info: ComposerInfo): string {
		const borderWidth = Math.max(0, width - 2);
		const contentWidth = Math.max(1, width - this.options.chromePadLeft - this.options.chromePadRight);
		const left = [info.modelName?.trim(), ...(info.flags ?? []).map((flag) => flag.trim()).filter(Boolean)].filter((part): part is string => Boolean(part)).join(" · ");
		const leftText = left ? ` ${left} ` : " ";
		const rightText = info.multiline ? "multiline " : "";
		if (!rightText) {
			const clipped = truncateToWidth(left, Math.max(0, contentWidth - 2), "", false);
			const clippedWidth = visibleWidth(stripTerminalSequences(clipped));
			const captionStart = Math.max(2, width - this.options.chromePadRight - clippedWidth - 1);
			const before = "─".repeat(Math.max(0, captionStart - 2));
			const after = "─".repeat(Math.max(0, width - captionStart - clippedWidth - 2));
			return `${backgroundize(this.borderColor(`╰${before} `), this.theme)}${backgroundize(this.theme.prompt_caption(clipped), this.theme)}${backgroundize(this.borderColor(` ${after}╯`), this.theme)}`;
		}
		const right = truncateToWidth(rightText, Math.max(0, contentWidth - 2), "", false);
		const rightWidth = visibleWidth(stripTerminalSequences(right));
		const maxLeft = Math.max(1, contentWidth - rightWidth - 1);
		const leftClipped = truncateToWidth(leftText, maxLeft, "", false);
		const leftWidth = visibleWidth(stripTerminalSequences(leftClipped));
		const rightStart = Math.max(1, width - this.options.chromePadRight - rightWidth);
		const leftStart = Math.max(1, rightStart - 1 - leftWidth);
		const before = "─".repeat(Math.max(0, leftStart - 1));
		const gap = "─".repeat(Math.max(0, rightStart - (leftStart + leftWidth)));
		const after = "─".repeat(Math.max(0, width - 1 - (rightStart + rightWidth)));
		return `${backgroundize(this.borderColor(`╰${before}`), this.theme)}${backgroundize(this.theme.prompt_caption(leftClipped), this.theme)}${backgroundize(this.borderColor(gap), this.theme)}${backgroundize(this.theme.prompt_caption(right), this.theme)}${backgroundize(this.borderColor(`${after}╯`), this.theme)}`;
	}

	private borderColor(value: string): string {
		return (this.focused ? this.theme.prompt_border_active : this.theme.prompt_border)(value);
	}
}

function selectCursorWindow(lines: readonly string[], budget: number): string[] {
	if (budget <= 0 || lines.length === 0) return [];
	if (lines.length <= budget) return [...lines];
	let start = Math.max(0, lines.length - budget);
	const cursor = lines.findIndex((line) => line.includes("\u001b_pi:c\u0007"));
	if (cursor >= 0 && cursor < start) start = cursor;
	if (cursor >= 0 && cursor >= start + budget) start = cursor - budget + 1;
	return lines.slice(start, start + budget);
}

function splitEditorLines(lines: readonly string[], width: number): { textLines: string[]; autocompleteLines: string[] } {
	if (lines.length === 0) return { textLines: [], autocompleteLines: [] };
	const body = lines.slice(1);
	const borderIndex = body.findIndex((line) => isEditorBorder(line, width));
	if (borderIndex < 0) return { textLines: body.map((line) => fitVisible(line, width)), autocompleteLines: [] };
	return {
		textLines: body.slice(0, borderIndex).map((line) => fitVisible(line, width)),
		autocompleteLines: body.slice(borderIndex + 1),
	};
}

function isEditorBorder(line: string, width: number): boolean {
	const plain = stripTerminalSequences(line);
	if (plain.startsWith("─── ") || plain.endsWith(" more ")) return true;
	return visibleWidth(plain) >= width && plain.replaceAll("─", "") === "";
}

function fitVisible(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, Math.floor(width)), "", true);
}

function positiveInt(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function resolveTitle(value: ComposerOptions["title"]): string | undefined {
	const title = typeof value === "function" ? value() : value;
	return title?.trim() || undefined;
}

/** pi-tui paints a reverse-video software caret in addition to CURSOR_MARKER.
 * The host owns the real terminal cursor, so remove only that duplicate cell style. */
function normalizeEditorCursor(value: string): string {
	const marker = "\u001b_pi:c\u0007";
	const markerIndex = value.indexOf(marker);
	if (markerIndex < 0) return value;
	const inverseIndex = markerIndex + marker.length;
	if (!value.startsWith("\u001b[7m", inverseIndex)) return value;
	const resetIndex = value.indexOf("\u001b[0m", inverseIndex + 4);
	if (resetIndex < 0) return value;
	return `${value.slice(0, inverseIndex)}${value.slice(inverseIndex + 4, resetIndex)}${value.slice(resetIndex + 4)}`;
}

/** Keep a prompt surface background across editor-internal `\x1b[0m` resets. */
function backgroundize(value: string, theme: SemanticTheme): string {
	const sample = theme.base?.(" ");
	if (!sample) return value;
	const match = sample.match(/^(\u001b\[[0-9;]*m) (\u001b\[[0-9;]*m)$/);
	if (!match) return value;
	const open = match[1] ?? "";
	const close = match[2] ?? "";
	return `${open}${value.replaceAll("\u001b[0m", `\u001b[0m${open}`)}${close}`;
}

function promptBlank(value: string, theme: SemanticTheme): string {
	return backgroundize(theme.status(value), theme);
}
