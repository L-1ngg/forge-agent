import { common, createLowlight } from "lowlight";
import type { CellStyle } from "./frame.ts";
import type { Theme } from "./theme.ts";
import type { StyledSpan } from "./transcript/types.ts";

const highlighter = createLowlight(common);
highlighter.registerAlias({ bash: ["shell", "sh"], typescript: ["tsx"], javascript: ["jsx"] });
type HighlightNode = ReturnType<typeof highlighter.highlight>["children"][number];

/** Pure highlighting: AST text and semantic colors, never HTML or terminal escapes. */
export function highlightCode(text: string, language: string | undefined, base: CellStyle, theme: Theme): StyledSpan[] {
	if (!language || !highlighter.registered(language)) return [{ text, style: base }];
	try {
		const spans: StyledSpan[] = [];
		const visit = (node: HighlightNode, style: CellStyle): void => {
			if (node.type === "text") spans.push({ text: node.value, style });
			else if (node.type === "element") {
				const classes = String(node.properties.className ?? "");
				const slot = /comment/.test(classes) ? "muted" : /keyword|built_in|type/.test(classes) ? "accent_assistant" : /string|regexp/.test(classes) ? "success" : /number|literal/.test(classes) ? "accent_edit" : /title|attr/.test(classes) ? "context" : undefined;
				const next = slot ? { ...style, foreground: theme.color(slot) } : style;
				for (const child of node.children) visit(child, next);
			}
		};
		for (const node of highlighter.highlight(language, text).children) visit(node, base);
		return spans.map(span => span.text).join("") === text ? spans : [{ text, style: base }];
	} catch { return [{ text, style: base }]; }
}
