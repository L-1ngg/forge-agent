import { expect, test } from "bun:test";
import { FocusStack, type FocusCard } from "../src/index.ts";
import type { Key } from "../src/keys.ts";

const esc: Key = { type: "escape" };
const tab: Key = { type: "tab" };
const space: Key = { type: "char", text: " " };

function card(id: string, focusableCount = 2): FocusCard {
	return { id, focusableCount };
}

test("Tab cycles inside the top card and never escapes it", () => {
	const stack = new FocusStack();
	stack.push(card("a", 3));
	expect(stack.handleKey(tab)).toMatchObject({ action: "focus_next", index: 1 });
	expect(stack.handleKey(tab)).toMatchObject({ action: "focus_next", index: 2 });
	expect(stack.handleKey(tab)).toMatchObject({ action: "focus_next", index: 0 });
	expect(stack.size).toBe(1);
});

test("Esc parks; Tab/Space resume without popping a response", () => {
	const stack = new FocusStack();
	stack.push(card("a"));
	expect(stack.handleKey(esc).action).toBe("park");
	expect(stack.active).toBe(false);
	expect(stack.hasParked).toBe(true);
	expect(stack.handleKey(tab)).toMatchObject({ action: "resume", card: { id: "a" } });
	expect(stack.active).toBe(true);
	stack.handleKey(esc);
	expect(stack.handleKey(space)).toMatchObject({ action: "resume", card: { id: "a" } });
});

test("remove archives a card that reached a terminal outcome", () => {
	const stack = new FocusStack();
	stack.push(card("a"));
	stack.push(card("b"));
	expect(stack.remove("a")?.id).toBe("a");
	expect(stack.top()?.id).toBe("b");
	stack.handleKey(esc);
	expect(stack.remove("b")?.id).toBe("b");
	expect(stack.hasParked).toBe(false);
	expect(stack.getScrollback().map((entry) => entry.id)).toEqual(["a", "b"]);
});
