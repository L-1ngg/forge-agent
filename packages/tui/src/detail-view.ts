import { backspace, createEditor, editorText, insertText, replaceEditor } from "./editor.ts";
import { defaultStyle, setCursor, writeText, type TerminalFrame } from "./frame.ts";
import type { Key } from "./keys.ts";
import type { Theme } from "./theme.ts";
import { truncateToWidth, wrapText, visibleWidth } from "./width.ts";
import type { EntryDetail } from "./transcript/detail.ts";

type ViewerAction = { type: "close" } | { type: "copy"; text: string } | undefined;
interface VisualRow { source: number; text: string; continuation: boolean; offset: number }

/** Owns only the independent reader; the main view retains its own draft and anchor. */
export class DetailView {
	private line = 0;
	private column = 0;
	private top = 0;
	private wrap = true;
	private follow: boolean;
	private selection: number | undefined;
	private query = "";
	private filter = "";
	private input: "search" | "filter" | undefined;
	private readonly queryDraft = createEditor();
	private visual: VisualRow[] = [];
	private height = 1;
	private detail: EntryDetail;

	constructor(readonly entryId: string, detail: EntryDetail) {
		this.detail = detail;
		this.follow = detail.live;
	}

	update(detail: EntryDetail): void { this.detail = detail; }

	handleKey(key: Key): ViewerAction {
		if (key.type === "ctrl" && key.key === "f") return { type: "close" };
		if (this.input) {
			if (key.type === "escape") this.input = undefined;
			else if (key.type === "enter") {
				if (this.input === "search") { this.query = editorText(this.queryDraft); this.find(1, true); }
				else { this.filter = editorText(this.queryDraft); this.top = 0; }
				this.input = undefined;
			} else if (key.type === "char" || key.type === "paste") insertText(this.queryDraft, key.text.replace(/\r?\n/g, ""));
			else if (key.type === "backspace") backspace(this.queryDraft);
			else if (key.type === "ctrl" && key.key === "u") replaceEditor(this.queryDraft, "", 0);
			return;
		}
		if (key.type === "escape") {
			if (this.selection !== undefined) this.selection = undefined;
			else return { type: "close" };
			return;
		}
		if (key.type === "mouse") {
			if (key.action === "up" || key.action === "down") this.move(key.action === "up" ? -3 : 3);
			return;
		}
		if (key.type === "arrow" && (key.direction === "up" || key.direction === "down")) this.move(key.direction === "up" ? -1 : 1);
		else if (key.type === "pageUp" || key.type === "pageDown") this.move((key.type === "pageUp" ? -1 : 1) * this.height);
		else if (key.type === "ctrl" && (key.key === "d" || key.key === "u")) this.move((key.key === "u" ? -1 : 1) * Math.max(1, Math.floor(this.height / 2)));
		else if (key.type === "home") this.move(-this.visual.length);
		else if (key.type === "end") this.move(this.visual.length);
		else if (key.type === "char") {
			switch (key.text) {
				case "q": if (this.selection === undefined) return { type: "close" }; break;
				case "j": this.move(1); break;
				case "k": this.move(-1); break;
				case "w": this.wrap = !this.wrap; this.top = 0; break;
				case "F": if (this.detail.live) this.follow = !this.follow; break;
				case "/": case "f":
					this.input = key.text === "/" ? "search" : "filter";
					{ const text = this.input === "search" ? this.query : this.filter; replaceEditor(this.queryDraft, text, text.length); }
					break;
				case "n": this.find(1); break;
				case "N": this.find(-1); break;
				case "v": case "V": this.selection = this.selection === undefined ? this.line : undefined; this.follow = false; break;
				case "y": {
					const start = Math.min(this.line, this.selection ?? this.line);
					const end = Math.max(this.line, this.selection ?? this.line);
					return { type: "copy", text: this.detail.lines.slice(start, end + 1).filter((line) => !this.filter || line.toLowerCase().includes(this.filter.toLowerCase())).join("\n") };
				}
				case "Y": return { type: "copy", text: this.detail.metadata };
			}
		}
	}

	private move(delta: number): void {
		this.follow = false;
		const at = Math.max(0, this.visualIndex());
		const index = Math.max(0, Math.min(this.visual.length - 1, at + delta));
		const target = this.visual[index];
		if (target) { this.line = target.source; this.column = target.offset; }
	}

	private matches(): { line: number; column: number }[] {
		const matches: { line: number; column: number }[] = [];
		if (!this.query) return matches;
		for (const [line, text] of this.detail.lines.entries()) {
			const lower = text.toLowerCase();
			if (this.filter && !lower.includes(this.filter.toLowerCase())) continue;
			let column = lower.indexOf(this.query.toLowerCase());
			while (column >= 0) { matches.push({ line, column }); column = lower.indexOf(this.query.toLowerCase(), column + Math.max(1, this.query.length)); }
		}
		return matches;
	}

	private visualIndex(): number {
		let index = -1;
		for (const [position, row] of this.visual.entries()) {
			if (row.source === this.line && (index === -1 || row.offset <= this.column)) index = position;
		}
		return index;
	}

	private find(direction: 1 | -1, inclusive = false): void {
		this.follow = false;
		const matches = this.matches();
		const ordered = direction === 1 ? matches : [...matches].reverse();
		const match = ordered.find((item) => direction === 1
			? item.line > this.line || item.line === this.line && (inclusive ? item.column >= this.column : item.column > this.column)
			: item.line < this.line || item.line === this.line && (inclusive ? item.column <= this.column : item.column < this.column)) ?? ordered[0];
		if (match) { this.line = match.line; this.column = match.column; this.top = Math.max(0, this.visualIndex()); }
	}

	paint(frame: TerminalFrame, theme: Theme, feedback?: string): void {
		const style = { ...defaultStyle(), foreground: theme.color("status") };
		const muted = { ...style, foreground: theme.color("muted") };
		this.height = Math.max(1, frame.rows - 3);
		const numbered = this.detail.firstLine !== undefined;
		const gutter = numbered ? String(this.detail.firstLine! + this.detail.lines.length - 1).length + 2 : 0;
		const width = Math.max(1, frame.columns - 2 - gutter);
		this.visual = this.detail.lines.flatMap((text, source) => {
			if (this.filter && !text.toLowerCase().includes(this.filter.toLowerCase())) return [];
			let consumed = 0;
			return (this.wrap ? wrapText(text, width) : [truncateToWidth(text.slice(this.column), width)]).map((part, index) => {
				const offset = this.wrap ? Math.max(consumed, text.indexOf(part, consumed)) : this.column;
				consumed = offset + part.length;
				return { source, text: part, continuation: index > 0, offset };
			});
		});
		if (this.follow) { this.line = this.visual.at(-1)?.source ?? 0; this.column = this.visual.at(-1)?.offset ?? 0; }
		let index = this.visualIndex();
		if (index < 0 && this.visual.length) { index = 0; this.line = this.visual[0]!.source; this.column = this.visual[0]!.offset; }
		if (index < this.top) this.top = Math.max(0, index);
		if (index >= this.top + this.height) this.top = index - this.height + 1;
		this.top = Math.min(this.top, Math.max(0, this.visual.length - this.height));
		writeText(frame, 1, 0, truncateToWidth(this.detail.title, Math.max(1, frame.columns - 2)), { ...style, attributes: { ...style.attributes, bold: true } });
		for (let row = 0; row < this.height; row++) {
			const value = this.visual[this.top + row];
			if (!value) break;
			const selected = this.selection !== undefined && value.source >= Math.min(this.selection, this.line) && value.source <= Math.max(this.selection, this.line);
			const match = !!this.query && value.text.toLowerCase().includes(this.query.toLowerCase());
			const background = selected ? theme.color("surface") : defaultStyle().background;
			if (numbered) writeText(frame, 1, row + 1, value.continuation ? " ".repeat(gutter) : `${String(this.detail.firstLine! + value.source).padStart(gutter - 2)}  `, muted);
			const foreground = this.detail.kind === "edit" ? theme.color(value.text.startsWith("+") ? "success" : value.text.startsWith("-") ? "error" : "status") : style.foreground;
			writeText(frame, 1 + gutter, row + 1, value.text, { ...style, foreground, background, attributes: { ...style.attributes, inverse: selected, underline: match || value.source === this.line } });
		}
		if (!this.visual.length) writeText(frame, 1, 1, this.filter ? "No matches" : "No output", muted);
		const matches = this.query ? this.matches().length : undefined;
		const status = feedback ?? `${this.line + (this.detail.firstLine ?? 1)}/${this.detail.lines.length}  ${this.wrap ? "wrap" : "nowrap"}${this.detail.live ? this.follow ? "  following" : "  paused" : ""}${this.filter ? `  filter: ${this.filter}` : ""}${matches !== undefined ? `  ${matches} matches` : ""}`;
		writeText(frame, 1, Math.max(0, frame.rows - 2), truncateToWidth(status, Math.max(1, frame.columns - 2)), muted);
		const footer = this.input ? `${this.input === "search" ? "/" : "filter: "}${editorText(this.queryDraft)}` : "esc:back  ctrl+c:quit  /:search  f:filter  y:copy  w:wrap";
		writeText(frame, 1, Math.max(0, frame.rows - 1), truncateToWidth(footer, Math.max(1, frame.columns - 2)), muted);
		if (this.input) setCursor(frame, Math.min(frame.columns - 1, 1 + visibleWidth(footer)), frame.rows - 1, "bar");
	}
}
