import type { DiffHunk, DiffLine, EditBlockData } from "@myh/protocol";
import { structuredPatch } from "diff";

export interface EditDiffOptions {
	context?: number;
}

/** Compute client-neutral line hunks once at the core boundary. */
export function createEditBlockData(path: string, oldText: string, newText: string, options: EditDiffOptions = {}): EditBlockData {
	const context = options.context ?? 3;
	if (!Number.isInteger(context) || context < 0) throw new RangeError("diff context must be a non-negative integer");
	const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context });
	const hunks = patch.hunks.map((hunk) => toProtocolHunk(hunk));
	return {
		path,
		hunks,
		additions: hunks.reduce((count, hunk) => count + hunk.additions, 0),
		removals: hunks.reduce((count, hunk) => count + hunk.removals, 0),
	};
}

export const diffText = createEditBlockData;

function toProtocolHunk(hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }): DiffHunk {
	let oldLine = hunk.oldStart;
	let newLine = hunk.newStart;
	const lines: DiffLine[] = [];
	let additions = 0;
	let removals = 0;
	for (const raw of hunk.lines) {
		// `diff` represents a missing final newline as a diagnostic pseudo-line.
		// It is not part of either file and must not consume a line number.
		if (raw === "\\ No newline at end of file") continue;
		const marker = raw[0];
		const content = raw.slice(1);
		if (marker === "+") {
			lines.push({ type: "add", content, newLine });
			newLine++;
			additions++;
		} else if (marker === "-") {
			lines.push({ type: "remove", content, oldLine });
			oldLine++;
			removals++;
		} else {
			lines.push({ type: "context", content, oldLine, newLine });
			oldLine++;
			newLine++;
		}
	}
	return { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines, additions, removals };
}
