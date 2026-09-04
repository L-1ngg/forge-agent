import type { CellStyle } from "./frame.ts";
import type { Theme } from "./theme.ts";
import { wrapText } from "./width.ts";
import type { EntryRow, StyledSpan } from "./transcript/types.ts";

function style(theme: Theme, slot: Parameters<Theme["color"]>[0], extra: Partial<CellStyle["attributes"]> = {}, background?: CellStyle["background"]): CellStyle {
	return {
		foreground: theme.color(slot),
		background: background ?? { kind: "default" },
		attributes: { bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false, ...extra },
	};
}

/** Minimal markdown for assistant bodies: headings, lists, fences, bold/italic/code. Not CommonMark. */
export function renderMarkdown(markdown: string, width: number, theme: Theme): EntryRow[] {
	const rows: EntryRow[] = [];
	let inFence = false;
	const codeBg = theme.color("dark_surface");
	const codeStyle = style(theme, "status", {}, codeBg);
	for (const line of markdown.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			rows.push({ spans: line ? [{ text: line, style: codeStyle }] : [], background: codeBg });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const body = heading[2] ?? "";
			for (const wrapped of wrapText(body, width)) rows.push({ spans: [{ text: wrapped, style: style(theme, "status", { bold: true }) }] });
			continue;
		}
		const list = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
		if (list) {
			const bullet = `${list[1] ?? ""}${list[2]} `;
			const rest = list[3] ?? "";
			const wrapped = wrapText(rest, Math.max(1, width - bullet.length));
			wrapped.forEach((part, index) => {
				rows.push({
					spans: [
						...(index === 0 ? [{ text: bullet, style: style(theme, "muted") }] : [{ text: " ".repeat(bullet.length), style: style(theme, "muted") }]),
						...parseInline(part, theme),
					],
				});
			});
			continue;
		}
		for (const wrapped of wrapText(line, width)) rows.push({ spans: parseInline(wrapped, theme) });
	}
	if (rows.length === 0) rows.push({ spans: [] });
	return rows;
}

function parseInline(text: string, theme: Theme): StyledSpan[] {
	const spans: StyledSpan[] = [];
	const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		if (start > last) spans.push({ text: text.slice(last, start), style: style(theme, "status") });
		const token = match[0]!;
		if (token.startsWith("**")) spans.push({ text: token.slice(2, -2), style: style(theme, "status", { bold: true }) });
		else if (token.startsWith("*")) spans.push({ text: token.slice(1, -1), style: style(theme, "status", { italic: true }) });
		else spans.push({ text: token.slice(1, -1), style: style(theme, "accent_edit") });
		last = start + token.length;
	}
	if (last < text.length) spans.push({ text: text.slice(last), style: style(theme, "status") });
	if (spans.length === 0 && text) spans.push({ text, style: style(theme, "status") });
	return spans;
}
