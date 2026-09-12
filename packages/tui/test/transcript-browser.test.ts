import { expect, test } from "bun:test";
import { createFrame, frameToText } from "../src/frame.ts";
import { createTheme } from "../src/theme.ts";
import { TranscriptBrowser } from "../src/transcript/browser.ts";
import { TranscriptProjector } from "../src/transcript/projector.ts";

function setup() {
	const projector = new TranscriptProjector();
	const browser = new TranscriptBrowser(projector, createTheme({ env: {} }));
	let width = 80, height = 24;
	const update = (columns = width, rows = height) => { width = columns; height = rows; browser.update(width, height); };
	const frame = () => {
		const result = createFrame(width, height);
		browser.paint(result, 0, true);
		return result;
	};
	const text = () => frameToText(frame());
	const row = (label: string) => {
		const index = text().split("\n").findIndex(line => line.includes(label));
		expect(index).toBeGreaterThanOrEqual(0);
		return index;
	};
	const read = (id: string, content = `${id}_BODY`) => {
		projector.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` }, timestamp: 1 });
		projector.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", content: JSON.stringify({ content }), isError: false, timestamp: 2 });
	};
	return { browser, projector, update, frame, text, row, read };
}

test("browse group, expand a member, append a call and resize without changing the selected detail target", () => {
	const { browser, update, text, row, read } = setup();
	read("first"); read("second"); update(); browser.enter();
	expect(text()).toContain("Read 2 files");
	expect(text()).not.toContain("first.ts");
	expect(browser.canView).toBe(true);
	expect(browser.openDetail()).toBeUndefined(); // The group reveals members instead of opening a viewer.
	expect(browser.openDetail()).toMatchObject({ name: "read", args: { path: "first.ts" } });
	browser.moveSelection(1);
	browser.fold("expanded");
	expect(text()).toContain("second_BODY");
	read("third"); update();
	for (const columns of [40, 120, 80]) {
		update(columns);
		expect(text()).toContain("third.ts"); // The existing group's new member stays revealed.
		expect(text()).toContain("second_BODY");
		expect(browser.openDetail()).toMatchObject({ args: { path: "second.ts" } });
	}
	browser.click(row("third.ts"), 1000);
	expect(browser.openDetail()).toMatchObject({ args: { path: "third.ts" } });
});

test("mouse header clicks and keyboard folding share read preview rules; dragging cancels the double click", () => {
	const { browser, update, text, row, read } = setup();
	read("file", Array.from({ length: 15 }, (_, i) => `CONTENT_${String(i).padStart(2, "0")}`).join("\n"));
	update(); browser.enter(); browser.openDetail();
	const header = row("file.ts");
	expect(browser.click(header, 1000)).toEqual({ selectText: false });
	expect(text()).not.toContain("CONTENT_00");
	browser.cancelClick();
	browser.click(header, 1100);
	expect(text()).not.toContain("CONTENT_00");
	browser.click(header, 1200);
	expect(text()).toContain("CONTENT_00");
	expect(text()).toContain("CONTENT_14");
	expect(text()).not.toContain("CONTENT_07");
	expect(browser.click(row("CONTENT_00"), 1250)).toEqual({ selectText: true });
	browser.fold("expanded");
	expect(text()).toContain("CONTENT_07");
	browser.fold();
	expect(text()).not.toContain("CONTENT_00");
	expect(browser.openDetail()).toMatchObject({ args: { path: "file.ts" } });
});

test("one reading anchor survives new calls, repeated reflow and a temporarily hidden transcript", () => {
	const { browser, update, text, read } = setup();
	read("long", Array.from({ length: 70 }, (_, i) => `ROW_${String(i).padStart(3, "0")} ${"x".repeat(80)}`).join("\n"));
	update(120, 12); browser.enter(); browser.openDetail(); browser.fold("expanded");
	browser.scrollPage(-1); browser.scrollPage(-1); browser.scrollPage(-1);
	const firstLine = () => text().match(/ROW_\d+/)?.[0];
	const before = firstLine();
	expect(before).toBeDefined(); expect(before).not.toBe("ROW_000");
	read("new-call"); update();
	for (let cycle = 0; cycle < 3; cycle++) {
		for (const columns of [40, 80, 120]) {
			update(columns); expect(firstLine()).toBe(before);
			expect(browser.selectedEntry).toMatchObject({ args: { path: "long.ts" } });
		}
	}
	update(40, 0); update(120, 12);
	expect(firstLine()).toBe(before);
	browser.scrollPage(1);
	const moved = firstLine();
	expect(moved).toBeDefined(); expect(moved).not.toBe(before);
	update(40); update(120);
	expect(firstLine()).toBe(moved);
	browser.jumpToEnd();
	expect(text()).toContain("Read 1 file");
});

test("painting and capability reads do not consume pending transcript changes or move the selected object", () => {
	const { browser, update, frame, text, read } = setup();
	read("first"); update(); browser.enter(); browser.openDetail();
	const before = frame();
	read("second");
	for (let i = 0; i < 3; i++) {
		expect(browser.canView).toBe(true); expect(browser.canFold).toBe(true);
		expect(frame()).toEqual(before);
	}
	update();
	expect(text()).toContain("second.ts");
	expect(browser.openDetail()).toMatchObject({ args: { path: "first.ts" } });
});

test("reset drops selection, expansion and scroll even when the next session reuses tool IDs", () => {
	const { browser, projector, update, text, read } = setup();
	read("same"); update(); browser.enter(); browser.openDetail(); browser.fold("expanded");
	expect(text()).toContain("same_BODY");
	projector.clear(); browser.reset();
	expect(browser.canView).toBe(false); expect(browser.canFold).toBe(false);
	expect(browser.selectedEntry).toBeUndefined();
	read("same", "NEW_BODY"); update();
	expect(text()).toContain("Read 1 file");
	expect(text()).not.toContain("same.ts");
	browser.enter(); browser.openDetail(); browser.fold("expanded");
	expect(text()).toContain("NEW_BODY");
	expect(text()).not.toContain("same_BODY");
});
