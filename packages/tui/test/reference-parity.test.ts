import { expect, test } from "bun:test";
import { join } from "node:path";
import { block } from "@myh/protocol";
import {
	compareDumps,
	computeEntryLayout,
	createFrame,
	createTheme,
	entryContentStartColumn,
	paintEntry,
	paintScenario,
	presentEntry,
	SCENARIOS,
	unwrapDump,
} from "../src/index.ts";

const goldenDir = join(import.meta.dir, "fixtures/golden");

test("each scenario dump is deterministic across two paints", () => {
	for (const spec of SCENARIOS) {
		expect(compareDumps(paintScenario(spec), paintScenario(spec)).status).toBe("equal");
	}
});

test("AC-49: candidate matches checked-in golden FrameDump", async () => {
	const failures: string[] = [];
	for (const spec of SCENARIOS) {
		const wrapped = unwrapDump(JSON.parse(await Bun.file(join(goldenDir, `${spec.name}.json`)).text()));
		const verdict = compareDumps(wrapped.frame, paintScenario(spec));
		if (verdict.status !== "equal") {
			failures.push(`${spec.name}: ${verdict.status === "diff" ? `${verdict.differingCells} cells` : verdict.status}`);
		}
	}
	expect(failures).toEqual([]);
});

test("AC-50: editing one golden cell turns the scenario red", async () => {
	const spec = SCENARIOS[0]!;
	const wrapped = unwrapDump(JSON.parse(await Bun.file(join(goldenDir, `${spec.name}.json`)).text()));
	const mutated = structuredClone(wrapped.frame);
	const cell = mutated.cells[0]![0]!;
	cell.grapheme = cell.grapheme === "x" ? "y" : "x";
	const verdict = compareDumps(wrapped.frame, mutated);
	expect(verdict.status).toBe("diff");
	if (verdict.status === "diff") expect(verdict.differingCells).toBe(1);
});

test("grok geometry invariants transcribed from upstream tests (no grok binary)", () => {
	expect(entryContentStartColumn()).toBe(3);
	const layoutWide = computeEntryLayout(80, "3:18 PM");
	expect(layoutWide.timestampWidth).toBe(10);
	const layoutNarrow = computeEntryLayout(14, "3:18 PM");
	expect(layoutNarrow.timestampWidth).toBe(0);

	const theme = createTheme({ mode: "truecolor" });
	const collapsed = presentEntry(
		{
			id: "t",
			kind: "thinking",
			block: block({ id: "t", kind: "thinking", lifecycle: "complete", defaultDisplayMode: "collapsed", currentDisplayMode: "collapsed" }, { markdown: "x" }, { defaultDisplayMode: "collapsed" }),
			durationMs: 2700,
		},
		60,
		theme,
	);
	const frame = createFrame(60, 4);
	paintEntry(frame, 0, collapsed, theme);
	expect(collapsed.chrome.collapsed).toBe(true);
	expect(frame.cells[0]![0]!.grapheme).toBe(" ");
});
