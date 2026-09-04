import { expect, test } from "bun:test";
import { FoldState, trimHeadTail, trimTail } from "../src/index.ts";

test("AC-17: a manual fold survives streaming default updates", () => {
	const fold = new FoldState({ defaultDisplayMode: "expanded" });
	fold.setDisplayMode("collapsed", true); // user folds mid-stream
	fold.updateDefault("expanded"); // stream keeps saying expanded
	expect(fold.displayMode).toBe("collapsed"); // does not reopen
	expect(fold.manualOverride).toBe(true);
});

test("updateDefault still drives blocks the user never touched", () => {
	const fold = new FoldState({ defaultDisplayMode: "truncated" });
	fold.updateDefault("collapsed");
	expect(fold.displayMode).toBe("collapsed");
});

test("updateFromEnvelope honors respectManualFolds=false", () => {
	const fold = new FoldState({ defaultDisplayMode: "expanded" });
	fold.setDisplayMode("collapsed", true);
	fold.updateFromEnvelope({ currentDisplayMode: "truncated", manualOverride: false }, { respectManualFolds: false });
	expect(fold.displayMode).toBe("truncated");
	expect(fold.manualOverride).toBe(false);
});

test("toggle flips collapsed/expanded and marks manual", () => {
	const fold = new FoldState({ defaultDisplayMode: "collapsed" });
	expect(fold.toggle()).toBe("expanded");
	expect(fold.manualOverride).toBe(true);
	expect(fold.toggle()).toBe("collapsed");
});

test("trimHeadTail keeps both ends with one marker", () => {
	expect(trimHeadTail(["1", "2", "3", "4", "5", "6", "7"], 2, 3, (n) => `+${n}`)).toEqual(["1", "2", "+2", "5", "6", "7"]);
	expect(trimHeadTail(["1", "2"], 2, 3, (n) => `+${n}`)).toEqual(["1", "2"]);
});

test("trimTail keeps the last lines behind an ellipsis", () => {
	expect(trimTail(["1", "2", "3", "4", "5"], 3)).toEqual(["…", "3", "4", "5"]);
	expect(trimTail(["1", "2"], 3)).toEqual(["1", "2"]);
});
