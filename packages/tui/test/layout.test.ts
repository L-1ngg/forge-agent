import { expect, test } from "bun:test";
import { computeScreenLayout, layoutOffsets, type ScreenLayoutPlan } from "../src/index.ts";

const ROWS = [8, 12, 16, 20, 24, 40];

function sum(plan: ScreenLayoutPlan): number {
	return plan.header.height + plan.transcript.height + plan.interactive.height + plan.status.height + plan.shortcuts.height;
}

test("layout stays non-negative and within the viewport at every locked size", () => {
	for (const rows of ROWS) {
		for (const hasStatus of [false, true]) {
			for (const composerLines of [1, 3, 9]) {
				const plan = computeScreenLayout({ columns: 80, rows, composerLines, hasStatus });
				expect(plan.header.height).toBeGreaterThanOrEqual(0);
				expect(plan.transcript.height).toBeGreaterThanOrEqual(0);
				expect(plan.interactive.height).toBeGreaterThanOrEqual(1);
				expect(plan.status.height).toBeGreaterThanOrEqual(0);
				expect(sum(plan)).toBeLessThanOrEqual(rows);
				expect(plan.interactive.height).toBeGreaterThanOrEqual(rows >= 5 ? 3 : 1);
			}
		}
	}
});

test("interactive slot and shortcuts survive even the shortest locked size", () => {
	const plan = computeScreenLayout({ columns: 40, rows: 8, composerLines: 1, hasStatus: true });
	expect(plan.interactive.height).toBeGreaterThanOrEqual(3);
	expect(plan.shortcuts.height).toBe(1);
	expect(plan.transcript.height).toBeGreaterThanOrEqual(1);
});

test("header hides at rows<=16 and status yields before the transcript floor", () => {
	expect(computeScreenLayout({ columns: 80, rows: 16, composerLines: 1, hasStatus: true }).header.height).toBe(0);
	const tall = computeScreenLayout({ columns: 80, rows: 24, composerLines: 1, hasStatus: true });
	expect(tall.header.height).toBe(1);
	expect(tall.status.height).toBe(1);
	// transcript floor of 5 wins over the status row when space is tight
	const tight = computeScreenLayout({ columns: 80, rows: 10, composerLines: 3, hasStatus: true });
	expect(tight.status.height).toBe(0);
	expect(tight.transcript.height).toBeGreaterThanOrEqual(1);
});

test("compact flag flips at rows<=20 and caps composer growth", () => {
	expect(computeScreenLayout({ columns: 80, rows: 20, composerLines: 1, hasStatus: false }).compact).toBe(true);
	expect(computeScreenLayout({ columns: 80, rows: 21, composerLines: 1, hasStatus: false }).compact).toBe(false);
	const compact = computeScreenLayout({ columns: 80, rows: 20, composerLines: 20, hasStatus: false });
	expect(compact.interactive.height).toBeLessThanOrEqual(5);
	const tall = computeScreenLayout({ columns: 80, rows: 40, composerLines: 20, hasStatus: false });
	expect(tall.interactive.height).toBeLessThanOrEqual(8);
});

test("offsets place regions top to bottom without overlap", () => {
	const plan = computeScreenLayout({ columns: 80, rows: 24, composerLines: 1, hasStatus: true });
	const offsets = layoutOffsets(plan);
	expect(offsets.header).toBe(0);
	expect(offsets.transcript).toBe(plan.header.height);
	expect(offsets.interactive).toBe(offsets.transcript + plan.transcript.height);
	expect(offsets.status).toBe(offsets.interactive + plan.interactive.height);
	expect(offsets.shortcuts).toBe(offsets.status + plan.status.height);
	expect(offsets.shortcuts + plan.shortcuts.height).toBeLessThanOrEqual(24);
});
