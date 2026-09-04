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
	const fence = rows.find((row) => row.spans.some((span) => span.text.includes("const x")));
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
