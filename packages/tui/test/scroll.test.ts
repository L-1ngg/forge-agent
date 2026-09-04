import { expect, test } from "bun:test";
import { ScrollState, type EntrySpan } from "../src/index.ts";

const spans: EntrySpan[] = [
	{ entryId: "a", start: 0, height: 4 },
	{ entryId: "b", start: 4, height: 6 },
	{ entryId: "c", start: 10, height: 4 },
];

test("follow mode pins the viewport to the end until the user scrolls", () => {
	const scroll = new ScrollState();
	expect(scroll.following).toBe(true);
	scroll.scrollBy(3, 10);
	expect(scroll.following).toBe(false);
	expect(scroll.offset).toBe(3);
	scroll.jumpToEnd();
	expect(scroll.following).toBe(true);
});

test("scroll offsets clamp to the content", () => {
	const scroll = new ScrollState();
	scroll.scrollBy(100, 10);
	expect(scroll.offset).toBe(10);
	scroll.scrollBy(-100, 10);
	expect(scroll.offset).toBe(0);
	expect(scroll.following).toBe(true);
});

test("anchor keeps the top entry in view across a reflow", () => {
	const scroll = new ScrollState();
	// total 14 rows, viewport 5: showing rows 5..9, top row inside entry b
	scroll.scrollBy(4, 9); // viewportTop = 14 - 4 - 5 = 5
	scroll.captureAnchor(spans, 14, 5);
	// reflow: entry a grows by 2 rows, b now starts at 6
	const grown: EntrySpan[] = [
		{ entryId: "a", start: 0, height: 6 },
		{ entryId: "b", start: 6, height: 6 },
		{ entryId: "c", start: 12, height: 4 },
	];
	scroll.restoreAnchor(grown, 16, 5);
	// b's second row is now at 6+1=7; offset = 16 - 5 - 7 = 4
	expect(scroll.offset).toBe(4);
	expect(scroll.following).toBe(false);
});

test("losing the anchored entry falls back gracefully", () => {
	const scroll = new ScrollState();
	scroll.scrollBy(4, 9);
	scroll.captureAnchor(spans, 14, 5);
	scroll.restoreAnchor([], 0, 5);
	expect(scroll.offset).toBe(4); // unchanged, anchor dropped
});
