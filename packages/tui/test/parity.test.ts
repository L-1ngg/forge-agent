import { expect, test } from "bun:test";
import { cloneFrame, compareDumps, createFrame, dumpFrame, hashDump, writeText, type ReferenceEnvironment } from "../src/index.ts";

const env: ReferenceEnvironment = {
	crateCommit: "bc7f02e",
	harnessPatchHash: "abc",
	rustc: "1.94.0",
	columns: 8,
	rows: 2,
	theme: "GrokNight",
	tick: 0,
	fixtureHash: "idle",
};

test("identical dumps hash equal and compare equal", () => {
	const frame = createFrame(8, 2);
	writeText(frame, 0, 0, "hello");
	const dump = dumpFrame(frame);
	expect(compareDumps(dump, dump).status).toBe("equal");
	expect(hashDump(dump)).toHaveLength(64);
	expect(hashDump(dump)).toBe(hashDump(structuredClone(dump)));
});

test("AC-50: changing one cell turns the parity gate red", () => {
	const before = createFrame(8, 2);
	writeText(before, 0, 0, "hello");
	const after = cloneFrame(before);
	after.cells[0]![1] = { ...after.cells[0]![1]!, grapheme: "x" };
	const verdict = compareDumps(dumpFrame(before), dumpFrame(after));
	expect(verdict.status).toBe("diff");
	if (verdict.status === "diff") expect(verdict.differingCells).toBe(1);
});

test("AC-48: a mismatched environment is not a cell diff", () => {
	const dump = dumpFrame(createFrame(8, 2));
	const verdict = compareDumps(dump, dump, env, { ...env, rustc: "1.00.0" });
	expect(verdict).toEqual({ status: "environment-mismatch", reason: "rustc: expected 1.94.0, got 1.00.0" });
});
