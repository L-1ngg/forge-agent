import { createHash } from "node:crypto";
import { diffFrames, dumpFrame, type FrameDump, type TerminalFrame } from "./frame.ts";

/** Fields that actually affect cell output (not PNG rasterization). */
export interface ReferenceEnvironment {
	crateCommit: string;
	harnessPatchHash: string;
	rustc: string;
	columns: number;
	rows: number;
	theme: string;
	tick: number;
	fixtureHash: string;
	term?: string;
	colorTerm?: string;
	locale?: string;
}

export type ParityVerdict =
	| { status: "equal"; hash: string }
	| { status: "environment-mismatch"; reason: string }
	| { status: "diff"; differingCells: number; cursorMismatch: boolean; hash: string };

const CELL_FIELDS = ["crateCommit", "harnessPatchHash", "rustc", "columns", "rows", "theme", "tick", "fixtureHash"] as const;

export function compareEnvironments(expected: ReferenceEnvironment, actual: ReferenceEnvironment): string | undefined {
	for (const field of CELL_FIELDS) {
		if (expected[field] !== actual[field]) return `${field}: expected ${expected[field]}, got ${actual[field]}`;
	}
	return undefined;
}

export function hashDump(dump: FrameDump): string {
	return createHash("sha256").update(JSON.stringify(dump)).digest("hex");
}

export function compareDumps(expected: FrameDump, actual: FrameDump, expectedEnv?: ReferenceEnvironment, actualEnv?: ReferenceEnvironment): ParityVerdict {
	if (expectedEnv && actualEnv) {
		const reason = compareEnvironments(expectedEnv, actualEnv);
		if (reason) return { status: "environment-mismatch", reason };
	}
	const before = frameFromDump(expected);
	const after = frameFromDump(actual);
	const diff = diffFrames(before, after);
	const hash = hashDump(actual);
	if (diff.equal) return { status: "equal", hash };
	return { status: "diff", differingCells: diff.differences.length, cursorMismatch: diff.cursorMismatch, hash };
}

export function frameFromDump(dump: FrameDump): TerminalFrame {
	return {
		columns: dump.columns,
		rows: dump.rows,
		cells: dump.cells.map((row) => row.map((cell) => ({ ...cell, foreground: { ...cell.foreground }, background: { ...cell.background }, attributes: { ...cell.attributes } }))),
		...(dump.cursor ? { cursor: { ...dump.cursor } } : {}),
	};
}

export function dumpHash(frame: TerminalFrame): string {
	return hashDump(dumpFrame(frame));
}
