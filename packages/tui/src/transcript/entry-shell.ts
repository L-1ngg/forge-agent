import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SemanticTheme } from "../theme.ts";
import { renderPlainEntryRows, rowsFromComponent, rowsFromText } from "./present.ts";
import { computeEntryLayout } from "./layout.ts";
import type { EntryChrome, EntryPresentation, EntryRowProvider } from "./types.ts";

export interface EntryShellOptions {
	id?: string;
	presentation?: EntryPresentation;
	body?: Component;
	text?: string;
	chrome?: Partial<EntryChrome>;
	theme: SemanticTheme;
}

export interface EntryAnchorRows {
	logicalLineStarts: readonly number[];
	lastContentRow: number;
}

/** Shared entry chrome adapter: one rail/padding/surface/timestamp owner. */
export class EntryShell implements Component {
	readonly id: string | undefined;
	private readonly theme: SemanticTheme;
	private body: Component | undefined;
	private text: string | undefined;
	private chrome: Partial<EntryChrome>;
	private presentation: EntryPresentation | undefined;

	constructor(options: EntryShellOptions) {
		this.id = options.id;
		this.theme = options.theme;
		this.body = options.body;
		this.text = options.text;
		this.chrome = { ...(options.chrome ?? {}) };
		this.presentation = options.presentation;
	}

	setPresentation(presentation: EntryPresentation): void {
		this.presentation = presentation;
	}

	setChrome(chrome: Partial<EntryChrome>): void {
		this.chrome = { ...chrome };
		this.presentation = undefined;
	}

	setBody(body: Component | undefined): void {
		this.body = body;
		this.presentation = undefined;
	}

	setText(text: string | undefined): void {
		this.text = text;
		this.presentation = undefined;
	}

	render(width: number): string[] {
		const presentation = this.resolvePresentation(width);
		return renderPlainEntryRows(presentation, width, this.theme);
	}

	/** Width-dependent map used to restore a manually parked viewport after reflow. */
	getAnchorRows(width: number): EntryAnchorRows {
		const presentation = this.resolvePresentation(width);
		const contentRows = Math.max(1, presentation.rows.length);
		const contentStart = presentation.chrome.vpadTop;
		const logicalLineStarts = presentation.rows.flatMap((row, index) => row.logicalLineStart === false ? [] : [contentStart + index]);
		if (logicalLineStarts.length === 0) logicalLineStarts.push(contentStart);
		return {
			logicalLineStarts,
			lastContentRow: contentStart + contentRows - 1,
		};
	}

	invalidate(): void {
		this.body?.invalidate();
	}

	private resolvePresentation(width: number): EntryPresentation {
		return this.presentation ?? this.buildPresentation(width);
	}

	private buildPresentation(width: number): EntryPresentation {
		const timestamp = this.chrome.timestamp;
		const layout = computeEntryLayout(width, this.chrome);
		const prefixWidth = this.chrome.showPrefix ? 2 : visibleWidth(this.chrome.contentPrefix ?? "");
		const bodyWidth = Math.max(1, layout.contentWidth - prefixWidth);
		const provider = this.body as EntryRowProvider | undefined;
		const rows = provider?.renderEntryRows
			? [...provider.renderEntryRows(layout.contentWidth)]
			: this.body
				? rowsFromComponent(this.body, { textWidth: bodyWidth })
				: rowsFromText(this.text ?? "", bodyWidth);
		return {
			rows,
			chrome: {
				vpadTop: 0,
				vpadBottom: 0,
				...this.chrome,
				...(timestamp === undefined ? {} : { timestamp }),
			},
		};
	}
}
