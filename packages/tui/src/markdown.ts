import { highlightCode } from "./code-highlight.ts";
import { Marked, type Token, type Tokens } from "marked";
import { defaultStyle, type CellStyle, type SourceDocument, type SourceRange } from "./frame.ts";
import type { Theme } from "./theme.ts";
import { graphemes, graphemeWidth, visibleWidth, truncateToWidth } from "./width.ts";
import type { EntryRow, StyledSpan } from "./transcript/types.ts";

const parser = new Marked({ gfm: true });
// Preserve formula source; this is a literal guard, not a math renderer.
parser.use({ extensions: [{
	name: "formulaLiteral", level: "inline",
	start: source => source.search(/\$|\\[([]/),
	tokenizer(source) {
		const opening = source.startsWith("$$") ? "$$" : source.startsWith("$") ? "$" : source.startsWith("\\(") ? "\\(" : source.startsWith("\\[") ? "\\[" : "";
		if (!opening) return;
		const closing = opening === "\\(" ? "\\)" : opening === "\\[" ? "\\]" : opening;
		let end = source.indexOf(closing, opening.length);
		while (end > 0 && source[end - 1] === "\\") end = source.indexOf(closing, end + closing.length);
		if (end < 0 && opening === "$" && !/[\\_^]/.test(source)) return;
		const raw = end < 0 ? source : source.slice(0, end + closing.length);
		return { type: "formulaLiteral", raw };
	},
}] });

/** Markdown is parsed before wrapping. Every visible run retains original source coordinates. */
export function renderMarkdown(markdown: string, width: number, theme: Theme): EntryRow[] {
	return new MarkdownLayout(markdown, Math.max(1, width), theme).render();
}

class MarkdownLayout {
	private readonly document: SourceDocument;
	private readonly base: CellStyle;
	private readonly lineStarts: number[] = [0];
	private readonly offsets: number[] = [];
	constructor(private readonly text: string, private readonly width: number, private readonly theme: Theme) {
		this.document = { text };
		this.text = "";
		for (let i = 0; i < text.length; i++) {
			if (text[i] === "\r" && text[i + 1] === "\n") continue;
			this.offsets.push(i); this.text += text[i] === "\r" ? "\n" : text[i];
		}
		this.offsets.push(text.length);
		this.base = { ...defaultStyle(), foreground: theme.color("status") };
		for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStarts.push(i + 1);
	}

	render(): EntryRow[] {
		return this.blocks(parser.lexer(this.text), 0, "");
	}

	private range(start: number, end: number, atomic?: { start: number; end: number }): SourceRange {
		return { document: this.document, start: this.offsets[start] ?? this.document.text.length, end: this.offsets[end] ?? this.document.text.length, ...(atomic ? { copyStart: this.offsets[atomic.start] ?? 0, copyEnd: this.offsets[atomic.end] ?? this.document.text.length } : {}) };
	}

	private span(text: string, start: number, end: number, style = this.base, atomic?: { start: number; end: number }): StyledSpan {
		return { text, style: { ...style, source: this.range(start, end, atomic) } };
	}

	private position(offset: number): { line: number; column: number } { return this.sourcePosition(this.offsets[offset] ?? this.document.text.length); }

	private sourcePosition(offset: number): { line: number; column: number } {
		let lo = 0, hi = this.lineStarts.length;
		while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (this.lineStarts[mid]! <= offset) lo = mid; else hi = mid; }
		return { line: lo, column: offset - this.lineStarts[lo]! };
	}

	/** A nested token may have quote/list prefixes removed; its children locate each source line separately. */
	private locate(value: string, from: number): number {
		const found = this.text.indexOf(value, from);
		return found < 0 ? from : found;
	}

	private literal(value: string, start: number, style: CellStyle, atomic?: { start: number; end: number }): StyledSpan[] {
		const result: StyledSpan[] = [];
		let cursor = start;
		for (const [index, line] of value.split("\n").entries()) {
			if (index > 0) { const newline = this.text.indexOf("\n", cursor); cursor = newline < 0 ? cursor : newline + 1; result.push(this.span("\n", Math.max(0, cursor - 1), cursor, style, atomic)); }
			const at = this.locate(line, cursor);
			result.push(this.span(line, at, at + line.length, style, atomic));
			cursor = at + line.length;
		}
		return result;
	}

	private inline(tokens: Token[], start: number, style = this.base, atomic?: { start: number; end: number }): StyledSpan[] {
		const result: StyledSpan[] = [];
		let cursor = start;
		for (const token of tokens) {
			const at = this.locate(token.raw, cursor);
			const end = at + token.raw.length;
			const construct = atomic ?? { start: at, end };
			if (token.type === "strong" || token.type === "em" || token.type === "del") {
				const inner = token as Tokens.Strong;
				const key = token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough";
				result.push(...this.inline(inner.tokens, at + (token.type === "em" ? 1 : 2), { ...style, attributes: { ...style.attributes, [key]: true } }, construct));
			} else if (token.type === "codespan") {
				result.push(this.span(token.text, at, end, { ...style, foreground: this.theme.color("accent_edit") }, construct));
			} else if (token.type === "link") {
				const link = token as Tokens.Link;
				const href = link.href.replace(/[\x00-\x20\x7f-\x9f]/g, "");
				const linkStyle = { ...style, foreground: this.theme.color("context"), attributes: { ...style.attributes, underline: true }, ...(/^(https?:|mailto:)/i.test(href) ? { hyperlink: href } : {}) };
				result.push(...this.inline(link.tokens, at + (token.raw.startsWith("[") ? 1 : 0), linkStyle, construct));
				if (link.text !== link.href) result.push(this.span(` (${link.href})`, at, end, linkStyle, construct));
			} else if (token.type === "br") result.push(this.span("\n", at, end, style, atomic));
			else if (token.type === "escape") result.push(this.span(token.text, at, end, style, construct));
			else if (token.type === "text" && "tokens" in token && token.tokens) result.push(...this.inline(token.tokens ?? [], at, style, atomic));
			else result.push(...this.literal(token.type === "text" ? token.text : token.raw, at, style, atomic));
			cursor = end;
		}
		return result;
	}

	private wrap(spans: StyledSpan[], fallback: number, prefix = "", continuation = prefix, width = this.width): EntryRow[] {
		const rows: EntryRow[] = [];
		let row: EntryRow = { spans: [], source: this.position(fallback) };
		let used = 0;
		const addPrefix = (value: string) => {
			const text = truncateToWidth(value, Math.max(0, width - 2));
			if (text) row.spans.push({ text, style: { ...this.base, foreground: this.theme.color("muted") } });
			used = visibleWidth(text);
		};
		addPrefix(prefix);
		let content = false;
		const next = () => { rows.push(row); row = { spans: [], source: this.position(fallback) }; addPrefix(continuation); content = false; };
		for (const span of spans) {
			let offset = 0;
			for (const char of graphemes(span.text)) {
				const range = span.style.source;
				const start = range ? Math.min(range.end, range.start + offset) : fallback;
				if (char === "\n") { next(); offset++; continue; }
				const value = char === "\t" ? "    " : char;
				let size = char === "\t" ? 4 : graphemeWidth(char);
				if (size === 0) { offset += char.length; continue; }
				if (used + size > width && content) next();
				// A one-cell viewport cannot contain a wide grapheme: retain its source behind a placeholder.
				const visible = size > width - used ? (size > width ? "�" : value.slice(0, Math.max(1, width - used))) : value;
				size = visibleWidth(visible);
				if (!content) row.source = this.sourcePosition(start);
				const source = range ? { ...range, start, end: Math.min(range.end, start + char.length) } : undefined;
				const previous = row.spans.at(-1);
				if (previous && source && previous.style.source?.end === source.start && previous.style.attributes === span.style.attributes && previous.style.foreground === span.style.foreground && previous.style.hyperlink === span.style.hyperlink && previous.style.source.copyStart === source.copyStart && previous.text.length === previous.style.source.end - previous.style.source.start && visible.length === char.length) {
					previous.text += visible; previous.style.source = { ...previous.style.source, end: source.end };
				} else row.spans.push({ text: visible, style: { ...span.style, ...(source ? { source } : {}) } });
				used += size; content = true; offset += char.length;
			}
		}
		rows.push(row);
		return rows;
	}

	private table(token: Tokens.Table, at: number, prefix: string, parentRange?: { start: number; end: number }): EntryRow[] {
		const atomic = parentRange ?? { start: at, end: at + token.raw.length };
		const cells = [token.header, ...token.rows];
		let cursor = at;
		const content = cells.map((row, rowIndex) => {
			if (rowIndex === 1) {
				const headerEnd = this.text.indexOf("\n", at);
				cursor = this.text.indexOf("\n", headerEnd + 1) + 1;
			}
			return row.map(cell => {
				const start = this.locate(cell.text, cursor);
				cursor = start + cell.text.length;
				return this.inline(cell.tokens, start, rowIndex === 0 ? { ...this.base, attributes: { ...this.base.attributes, bold: true } } : this.base, atomic);
			});
		});
		const columns = token.header.length;
		const available = this.width - visibleWidth(prefix) - columns * 3 - 1;
		const rows: EntryRow[] = [];
		if (available < columns * 6) {
			for (const [rowIndex, row] of content.slice(1).entries()) {
				for (const [column, spans] of row.entries()) {
					const label = `${token.header[column]!.text || `Column ${column + 1}`}: `;
					const valueAt = spans[0]?.style.source?.start ?? at;
					rows.push(...this.wrap([this.span(label, valueAt, valueAt, this.base, atomic), ...spans], at, prefix));
				}
				if (rowIndex < content.length - 2) rows.push({ spans: [], source: this.position(at) });
			}
			if (content.length === 1) rows.push(...this.wrap([this.span(token.header.map(cell => cell.text).join(" | "), at, atomic.end, this.base, atomic)], at, prefix));
			return rows;
		}
		const widths = token.header.map((_, column) => Math.max(1, ...content.map(row => visibleWidth(row[column]!.map(span => span.text).join("")))));
		while (widths.reduce((sum, value) => sum + value, 0) > available) {
			const widest = widths.indexOf(Math.max(...widths)); widths[widest]!--;
		}
		const border = (left: string, middle: string, right: string, source = at) => this.wrap([this.span(left + widths.map(w => "─".repeat(w + 2)).join(middle) + right, source, source, { ...this.base, foreground: this.theme.color("muted") }, atomic)], at, prefix);
		rows.push(...border("┌", "┬", "┐"));
		for (const [index, row] of content.entries()) {
			const wrapped = row.map((spans, column) => this.wrap(spans, at, "", "", widths[column]!));
			for (let line = 0; line < Math.max(...wrapped.map(cell => cell.length)); line++) {
				const spans: StyledSpan[] = [this.span(prefix + "│ ", at, atomic.end, this.base, atomic)];
				for (let column = 0; column < columns; column++) {
					const cell = wrapped[column]![line]?.spans ?? [];
					const gap = widths[column]! - visibleWidth(cell.map(s => s.text).join(""));
					const align = token.align[column];
					const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
					spans.push(this.span(" ".repeat(left), at, atomic.end, this.base, atomic), ...cell, this.span(" ".repeat(gap - left) + " │" + (column < columns - 1 ? " " : ""), at, atomic.end, this.base, atomic));
				}
				const source = spans.find(s => s.text.trim() && s.style.source && s.style.source.start > at)?.style.source?.start ?? at;
				rows.push({ spans, source: this.sourcePosition(source) });
			}
			if (index === 0) rows.push(...border("├", "┼", "┤", at + (token.raw.indexOf("\n") < 0 ? token.raw.length : token.raw.indexOf("\n"))));
		}
		rows.push(...border("└", "┴", "┘", Math.max(at, atomic.end - 1)));
		return rows;
	}

	private blocks(tokens: Token[], start: number, prefix: string, atomic?: { start: number; end: number }): EntryRow[] {
		const rows: EntryRow[] = [];
		let cursor = start;
		for (const token of tokens) {
			const at = this.locate(token.raw, cursor);
			const end = at + token.raw.length;
			if (token.type === "space") {
				for (let i = 1; i < token.raw.split("\n").length - 1; i++) rows.push({ spans: [], source: this.position(at) });
			} else if (token.type === "heading") {
				rows.push(...this.wrap(this.inline(token.tokens ?? [], at, { ...this.base, attributes: { ...this.base.attributes, bold: true } }, atomic ?? { start: at, end }), at, prefix));
			} else if (token.type === "paragraph" || token.type === "text") {
				rows.push(...this.wrap(this.inline(token.tokens ?? [], at, this.base, atomic), at, prefix));
			} else if (token.type === "list") {
				let itemAt = at;
				for (const [index, item] of token.items.entries()) {
					itemAt = this.locate(item.raw, itemAt);
					const marker = `${token.ordered ? `${Number(token.start) + index}.` : "-"} `;
					const child = this.blocks(item.tokens, itemAt + (item.raw.match(/^\s*(?:[-+*]|\d+[.)])\s+/)?.[0].length ?? 0), prefix + " ".repeat(marker.length), atomic ?? { start: itemAt, end: itemAt + item.raw.length });
					if (child[0]) {
						const first = child[0].spans[0];
						if (first && !first.style.source) first.text = truncateToWidth(prefix + marker, Math.max(0, this.width - 2));
					}
					rows.push(...child); itemAt += item.raw.length;
				}
			} else if (token.type === "blockquote") rows.push(...this.blocks(token.tokens ?? [], at, prefix + "│ ", atomic ?? { start: at, end }));
			else if (token.type === "table") rows.push(...this.table(token as Tokens.Table, at, prefix, atomic));
			else if (token.type === "code") {
				const code = token as Tokens.Code;
				const contentStart = code.codeBlockStyle === "indented" ? at : this.text.indexOf("\n", at) + 1;
				const codeAt = Math.max(contentStart, this.text.indexOf(code.text.split("\n")[0] ?? "", contentStart));
				const codeStyle = { ...this.base, background: this.theme.color("dark_surface") };
				let offset = codeAt;
				const lines: StyledSpan[][] = [[]];
				for (const span of highlightCode(code.text, code.lang?.split(/\s+/)[0]?.toLowerCase(), codeStyle, this.theme)) {
					const parts = span.text.split("\n");
					for (const [index, part] of parts.entries()) {
						if (index > 0) { lines.push([]); offset++; }
						offset = this.locate(part, offset);
						lines.at(-1)!.push(this.span(part, offset, offset + part.length, span.style, atomic ?? { start: at, end })); offset += part.length;
					}
				}
				for (const line of lines) {
					const body = line.map(span => span.text).join("");
					const indent = body.match(/^\s*/)?.[0] ?? "";
					const continuation = prefix + truncateToWidth(indent, Math.max(0, Math.floor(this.width / 3))) + "↪ ";
					rows.push(...this.wrap(line, codeAt, prefix, continuation).map(row => ({ ...row, background: codeStyle.background })));
				}
			} else if (token.type === "hr") rows.push(...this.wrap([this.span("─".repeat(Math.max(1, this.width - visibleWidth(prefix))), at, end, this.base, { start: at, end })], at, prefix));
			else rows.push(...this.wrap([this.span(token.raw, at, end)], at, prefix));
			cursor = end;
		}
		return rows.length ? rows : [{ spans: [], source: this.position(start) }];
	}
}
