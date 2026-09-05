import { expect, test } from "bun:test";
import { block } from "@myh/protocol";
import { createTheme, presentEntry, visibleWidth, type TranscriptEntry } from "../src/index.ts";

const theme = createTheme({ mode: "truecolor" });

function rowTexts(presentation: { rows: { spans: { text: string }[] }[] }): string[] {
	return presentation.rows.map((row) => row.spans.map((span) => span.text).join(""));
}

test("user entry wraps the full prompt instead of truncating", () => {
	const entry: TranscriptEntry = { id: "u", kind: "user", text: "a] ".repeat(30) + "end", timestamp: 0 };
	const presentation = presentEntry(entry, 20, theme);
	const joined = rowTexts(presentation).join("");
	expect(joined).toContain("end"); // nothing dropped at width 20
	expect(rowTexts(presentation).length).toBeGreaterThan(1); // wrapped
});

test("thinking: streaming expands with rail, complete collapses to the duration summary", () => {
	const streaming: TranscriptEntry = {
		id: "t",
		kind: "thinking",
		block: block({ id: "t", kind: "thinking", lifecycle: "streaming", defaultDisplayMode: "expanded" }, { markdown: "l1\nl2\nl3\nl4\nl5" }, { defaultDisplayMode: "expanded", truncatedLines: 3 }),
	};
	const streamingOut = presentEntry(streaming, 60, theme);
	expect(rowTexts(streamingOut)[0]).toBe("◆ Thinking…");
	expect(streamingOut.chrome.rail).toBeDefined();

	const complete: TranscriptEntry = {
		id: "t",
		kind: "thinking",
		block: block({ id: "t", kind: "thinking", lifecycle: "complete", defaultDisplayMode: "collapsed" }, { markdown: "l1" }, {}),
		durationMs: 2700,
	};
	const completeOut = presentEntry(complete, 60, theme);
	expect(rowTexts(completeOut)).toEqual(["◆ Thought for 2.7s"]);
	expect(completeOut.chrome.collapsed).toBe(true);
});

test("thinking truncated mode keeps the tail behind a muted ellipsis", () => {
	const entry: TranscriptEntry = {
		id: "t",
		kind: "thinking",
		block: block({ id: "t", kind: "thinking", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated" }, { markdown: "l1\nl2\nl3\nl4\nl5" }, { truncatedLines: 2 }),
	};
	expect(rowTexts(presentEntry(entry, 60, theme))).toEqual(["◆ Thought", "…", "l4", "l5"]);
});

test("AC-29: execute truncates first/last and never duplicates toolResult content", () => {
	const entry: TranscriptEntry = {
		id: "e",
		kind: "execute",
		block: block(
			{ id: "e", kind: "execute", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated" },
			{ command: "ls", stdout: "1\n2\n3\n4\n5\n6\n7\n8\n", exitCode: 0 },
			{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3 },
		),
	};
	const out = presentEntry(entry, 60, theme);
	expect(rowTexts(out)).toEqual(["Run ls", "1", "2", "… +3 lines", "6", "7", "8"]);
	expect(out.rows[4]!.background).toEqual(theme.color("stdout_panel")); // marker row keeps the panel band
});

test("failed execute turns the header to the error accent", () => {
	const entry: TranscriptEntry = {
		id: "e",
		kind: "execute",
		block: block({ id: "e", kind: "execute", lifecycle: "failed", defaultDisplayMode: "collapsed", currentDisplayMode: "collapsed" }, { command: "bad", exitCode: 1, isError: true }, {}),
	};
	const out = presentEntry(entry, 60, theme);
	expect(out.rows[0]!.spans[1]!.style.foreground).toEqual(theme.color("accent_error"));
});

test("edit shows +N/-M on the header and typed diff bands when expanded", () => {
	const entry: TranscriptEntry = {
		id: "d",
		kind: "edit",
		block: block(
			{ id: "d", kind: "edit", lifecycle: "complete", defaultDisplayMode: "expanded", currentDisplayMode: "expanded" },
			{
				path: "src/deep/module.ts",
				hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, additions: 1, removals: 1, lines: [
					{ type: "remove", content: "old()", oldLine: 3 },
					{ type: "add", content: "new()", newLine: 3 },
				] }],
				additions: 1,
				removals: 1,
			},
			{ defaultDisplayMode: "expanded" },
		),
	};
	const out = presentEntry(entry, 60, theme);
	expect(rowTexts(out)[0]).toBe("Edit module.ts +1/-1"); // basename, not the full path
	expect(out.rows[1]!.background).toEqual(theme.color("diff_remove"));
	expect(out.rows[2]!.background).toEqual(theme.color("diff_add"));
	expect(rowTexts(out)[1]).toContain("- old()");
	expect(rowTexts(out)[2]).toContain("+ new()");
});

test("assistant keeps fenced code verbatim on a surface band", () => {
	const entry: TranscriptEntry = { id: "a", kind: "assistant", markdown: "before\n```ts\nconst x = 1;\n```\nafter", timestamp: 0, lifecycle: "complete" };
	const out = presentEntry(entry, 60, theme);
	const texts = rowTexts(out);
	expect(texts).toEqual(["before", "const x = 1;", "after"]);
	expect(out.rows[1]!.background).toEqual(theme.color("dark_surface"));
});

test("long code, thinking and execute output wrap without losing content", () => {
	const text = "abcdefghijklmnop".repeat(4);
	const entries: TranscriptEntry[] = [
		{ id: "code", kind: "assistant", markdown: `\`\`\`ts\n${text}\n\`\`\``, lifecycle: "complete" },
		{ id: "thinking", kind: "thinking", block: block({ id: "thinking", kind: "thinking", lifecycle: "streaming" }, { markdown: text }, { defaultDisplayMode: "expanded" }) },
		{ id: "execute", kind: "execute", block: block({ id: "execute", kind: "execute", lifecycle: "complete" }, { command: "echo", stdout: text }, { defaultDisplayMode: "expanded" }) },
	];
	for (const entry of entries) {
		const rows = rowTexts(presentEntry(entry, 20, theme));
		expect(rows.every((row) => visibleWidth(row) <= 20)).toBe(true);
		expect(rows.join("")).toContain(text);
	}
});
