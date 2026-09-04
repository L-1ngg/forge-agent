import { block } from "@myh/protocol";
import { createFrame, dumpFrame, type FrameDump } from "./frame.ts";
import { createTheme } from "./theme.ts";
import { paintEntry, entryHeight, computeEntryLayout } from "./transcript/entry-shell.ts";
import { presentEntry } from "./transcript/present.ts";
import type { TranscriptEntry } from "./transcript/types.ts";

/** Unix ms for 2026-09-04 15:18:00 UTC — capture runs with TZ=UTC so grok prints "3:18 PM". */
export const SCENARIO_TIMESTAMP = Date.UTC(2026, 8, 4, 15, 18, 0);

export interface ScenarioSpec {
	name: string;
	columns: number;
	rows: number;
	entries: () => TranscriptEntry[];
}

const thinkingBody = "l1\nl2\nl3\nl4\nl5";

function thinking(mode: "collapsed" | "truncated" | "expanded"): TranscriptEntry {
	return {
		id: "t1",
		kind: "thinking",
		durationMs: 2700,
		block: block(
			{ id: "t1", kind: "thinking", lifecycle: "complete", defaultDisplayMode: mode, currentDisplayMode: mode },
			{ markdown: thinkingBody },
			{ defaultDisplayMode: mode, truncatedLines: 3 },
		),
	};
}

export const SCENARIOS: readonly ScenarioSpec[] = [
	{ name: "user-hello-80", columns: 80, rows: 6, entries: () => [{ id: "u1", kind: "user", text: "hello", timestamp: SCENARIO_TIMESTAMP }] },
	{ name: "user-hello-40", columns: 40, rows: 6, entries: () => [{ id: "u1", kind: "user", text: "hello", timestamp: SCENARIO_TIMESTAMP }] },
	{
		name: "assistant-md-80",
		columns: 80,
		rows: 12,
		entries: () => [{ id: "a1", kind: "assistant", markdown: "# Title\nbefore\n```ts\nconst x = 1;\n```\nafter", timestamp: SCENARIO_TIMESTAMP, lifecycle: "complete" }],
	},
	{ name: "thinking-collapsed-80", columns: 80, rows: 4, entries: () => [thinking("collapsed")] },
	{ name: "thinking-truncated-80", columns: 80, rows: 10, entries: () => [thinking("truncated")] },
	{ name: "thinking-expanded-80", columns: 80, rows: 10, entries: () => [thinking("expanded")] },
	{
		name: "execute-truncated-80",
		columns: 80,
		rows: 12,
		entries: () => [
			{
				id: "e1",
				kind: "execute",
				block: block(
					{ id: "e1", kind: "execute", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated" },
					{ command: "ls", stdout: "1\n2\n3\n4\n5\n6\n7\n8\n", exitCode: 0 },
					{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3 },
				),
			},
		],
	},
	{
		name: "execute-failed-80",
		columns: 80,
		rows: 6,
		entries: () => [
			{
				id: "e1",
				kind: "execute",
				block: block(
					{ id: "e1", kind: "execute", lifecycle: "failed", defaultDisplayMode: "collapsed", currentDisplayMode: "collapsed" },
					{ command: "bad", exitCode: 1, isError: true },
					{ defaultDisplayMode: "collapsed" },
				),
			},
		],
	},
	{
		name: "edit-expanded-80",
		columns: 80,
		rows: 10,
		entries: () => [
			{
				id: "d1",
				kind: "edit",
				block: block(
					{ id: "d1", kind: "edit", lifecycle: "complete", defaultDisplayMode: "expanded", currentDisplayMode: "expanded" },
					{
						path: "src/deep/module.ts",
						hunks: [
							{
								oldStart: 3,
								oldLines: 1,
								newStart: 3,
								newLines: 1,
								additions: 1,
								removals: 1,
								lines: [
									{ type: "remove", content: "old()", oldLine: 3 },
									{ type: "add", content: "new()", newLine: 3 },
								],
							},
						],
						additions: 1,
						removals: 1,
					},
					{ defaultDisplayMode: "expanded" },
				),
			},
		],
	},
	{
		name: "transcript-stack-80x16",
		columns: 80,
		rows: 16,
		entries: () => [
			{ id: "u1", kind: "user", text: "hello", timestamp: SCENARIO_TIMESTAMP },
			thinking("collapsed"),
			{ id: "a1", kind: "assistant", markdown: "# Title\nbefore\n```ts\nconst x = 1;\n```\nafter", timestamp: SCENARIO_TIMESTAMP, lifecycle: "complete" },
		],
	},
];

export function paintScenario(spec: ScenarioSpec): FrameDump {
	process.env.TZ = "UTC";
	const theme = createTheme({ mode: "truecolor" });
	const frame = createFrame(spec.columns, spec.rows);
	let y = 0;
	for (const entry of spec.entries()) {
		const hasTimestamp = entry.kind === "user" || entry.kind === "assistant";
		const layout = computeEntryLayout(spec.columns, hasTimestamp ? "3:18 PM" : undefined);
		const presentation = presentEntry(entry, layout.contentWidth, theme);
		const height = entryHeight(presentation);
		if (y + height > spec.rows) break;
		paintEntry(frame, y, presentation, theme);
		y += height;
	}
	return dumpFrame(frame);
}
