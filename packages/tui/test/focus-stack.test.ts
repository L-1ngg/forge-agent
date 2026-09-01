import { expect, test } from "bun:test";
import { FocusStack } from "../src/index.ts";

for (const kind of ["permission", "cancel_confirm", "question", "oauth"] as const) {
	test(`${kind} card obeys the shared focus contract`, () => {
		const stack = new FocusStack();
		const card = { id: kind, focusableCount: 3, shortcuts: ["Tab next", "Esc close"] };
		stack.push(card);

		expect(stack.top()).toEqual(card);
		expect(stack.handleInput("\t").index).toBe(1);
		expect(stack.handleInput("\t").index).toBe(2);
		expect(stack.handleInput("\t").index).toBe(0);
		expect(stack.shortcuts()).toEqual(card.shortcuts);
		expect(stack.handleInput("\u001b")).toMatchObject({ action: "pop", card });
		expect(stack.size).toBe(0);
		expect(stack.getScrollback()).toEqual([card]);
	});
}

test("Esc pops only the top card", () => {
	const stack = new FocusStack();
	stack.push({ id: "first" });
	stack.push({ id: "second" });
	stack.handleInput("\u001b");
	expect(stack.top()?.id).toBe("first");
	expect(stack.getScrollback().map((card) => card.id)).toEqual(["second"]);
});

test("a terminal outcome can retire a non-top card without stealing focus", () => {
	const stack = new FocusStack();
	stack.push({ id: "first", focusableCount: 2 });
	stack.push({ id: "second", focusableCount: 3 });
	stack.handleInput("\t");

	expect(stack.remove("first")?.id).toBe("first");
	expect(stack.top()?.id).toBe("second");
	expect(stack.focusIndex).toBe(1);
	expect(stack.getScrollback().map((card) => card.id)).toEqual(["first"]);
});

test("retiring the top card resets focus for the newly exposed card", () => {
	const stack = new FocusStack();
	stack.push({ id: "first", focusableCount: 3 });
	stack.push({ id: "second", focusableCount: 3 });
	stack.handleInput("\t");

	expect(stack.remove("second")?.id).toBe("second");
	expect(stack.top()?.id).toBe("first");
	expect(stack.focusIndex).toBe(0);
});

test("invalid focusable counts fall back to one control", () => {
	for (const focusableCount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const stack = new FocusStack();
		stack.push({ id: String(focusableCount), focusableCount });
		expect(stack.handleInput("\t")).toMatchObject({ action: "focus_next", index: 0 });
		expect(Number.isFinite(stack.focusIndex)).toBe(true);
	}
});
