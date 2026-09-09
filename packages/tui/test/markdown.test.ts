import { expect, test } from "bun:test";
import { createTheme, renderMarkdown } from "../src/index.ts";

const theme = createTheme({ mode: "truecolor" });

function texts(markdown: string): string[] {
	return renderMarkdown(markdown, 40, theme).map((row) => row.spans.map((span) => span.text).join(""));
}

test("headings, lists, fences, bold and italic are recognized", () => {
	const rows = renderMarkdown("# Title\n- item\n**bold** and *em* and `code`\n```ts\nconst x = 1;\n```", 40, theme);
	const joined = rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
	expect(joined).toContain("Title");
	expect(joined).toContain("item");
	expect(joined).toContain("bold");
	expect(joined).toContain("em");
	expect(joined).toContain("code");
	expect(joined).toContain("const x = 1;");
	expect(rows[0]!.spans[0]!.style.attributes.bold).toBe(true);
	const italic = rows.flatMap((row) => row.spans).find((span) => span.text === "em");
	expect(italic?.style.attributes.italic).toBe(true);
	const fence = rows.find((row) => row.spans.map(span => span.text).join("").includes("const x"));
	expect(fence?.background).toEqual(theme.color("dark_surface"));
});

test("tui source does not contain slash or mention parsers", async () => {
	const root = `${import.meta.dir}/..`;
	const glob = new Bun.Glob("src/**/*.ts");
	for await (const path of glob.scan({ cwd: root })) {
		const source = await Bun.file(`${root}/${path}`).text();
		expect(source).not.toMatch(/parseSlashCommand|slashCommandPrefix|parseMentions|activeMention/);
	}
});

test("bold remains styled when its delimiters span terminal rows", () => {
	const rows = renderMarkdown("**abcdefghijklmnop**", 8, theme);
	expect(rows.map(row => row.spans.map(span => span.text).join("")).join("")).toBe("abcdefghijklmnop");
	expect(rows.flatMap(row => row.spans).every(span => span.style.attributes.bold)).toBe(true);
});

test("tables wrap cells, fall back to labelled records, and recover at wider widths", () => {
	const md = "| Name | State | Description |\n| --- | --- | --- |\n| Markdown | ready | 中文 and long text |";
	const wide = renderMarkdown(md, 80, theme).map(row => row.spans.map(span => span.text).join("")).join("\n");
	expect(wide).toContain("│");
	expect(wide).not.toContain("---");
	const narrow = renderMarkdown(md, 20, theme).map(row => row.spans.map(span => span.text).join("")).join("\n");
	expect(narrow).toContain("Name: Markdown");
	expect(narrow).toContain("State: ready");
	expect(narrow).not.toContain("---");
	expect(renderMarkdown(md, 80, theme).map(row => row.spans.map(span => span.text).join("")).join("\n")).toBe(wide);
});

test("code highlights explicit languages and distinguishes display continuations", () => {
	const md = "```ts\n    const answer: number = 123456789;\n```";
	const rows = renderMarkdown(md, 20, theme);
	expect(rows.some(row => row.spans.some(span => span.text.includes("↪")))).toBe(true);
	expect(new Set(rows.flatMap(row => row.spans).filter(span => span.text.trim() && span.style.source).map(span => JSON.stringify(span.style.foreground))).size).toBeGreaterThan(1);
	const plain = renderMarkdown("```unknown\nconst answer = 1;\n```", 80, theme);
	expect(new Set(plain.flatMap(row => row.spans).map(span => JSON.stringify(span.style.foreground))).size).toBe(1);
});

test("LaTeX is literal while Markdown around it still renders", () => {
	const md = String.raw`**before** $x_i + y_j$ and \(a_b + c_d\)
$$
\frac{x_i}{y_j}
$$`;
	const text = renderMarkdown(md, 80, theme).map(row => row.spans.map(span => span.text).join("")).join("\n");
	expect(text).toContain(String.raw`$x_i + y_j$`);
	expect(text).toContain(String.raw`\(a_b + c_d\)`);
	expect(text).toContain(String.raw`\frac{x_i}{y_j}`);
	expect(text).not.toContain("**before**");
});

test("supported structures fit narrow widths and keep links visible", () => {
	const md = "# **Heading**\n\n1. first\n   - *nested* and ~~deleted~~\n\n> quoted `code`\n\n---\n\n[docs](https://example.com/docs)\n\n[https://example.com](https://example.com)\n\n中文 é 👨‍👩‍👧‍👦";
	for (const width of [80, 40, 20, 3, 1]) {
		const rows = renderMarkdown(md, width, theme);
		for (const row of rows) expect(Bun.stringWidth(row.spans.map(span => span.text).join(""))).toBeLessThanOrEqual(width);
	}
	const rendered = renderMarkdown(md, 80, theme);
	const text = rendered.map(row => row.spans.map(span => span.text).join("")).join("\n");
	expect(text).toContain("1. first");
	expect(text).toContain("  - nested");
	expect(text).toContain("│ quoted code");
	expect(text).toContain("docs (https://example.com/docs)");
	expect(text).not.toContain("https://example.com (https://example.com)");
	expect(rendered.flatMap(row => row.spans).some(span => span.style.attributes.strikethrough)).toBe(true);
});

test("incomplete syntax remains readable, including unclosed code and table headers", () => {
	for (const md of ["**unfinished", "`unfinished", "```ts\nconst unfinished = 1;", "| Name |\n| --- |\n| unfinished |", "~~unfinished"]) {
		const rows = renderMarkdown(md, 80, theme);
		expect(rows.map(row => row.spans.map(span => span.text).join("")).join("\n")).toContain("unfinished");
	}
});
