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
