import { expect, test } from "bun:test";
import { nextEscStep, resolveKeyOwner, shortcutRoutes, type InputRouterState } from "../src/index.ts";

const idle: InputRouterState = { cardFocused: false, cardParked: false, editorFocused: true, running: false };

test("key owner priority is card → scrollback → composer → global", () => {
	expect(resolveKeyOwner({ cardFocused: true, cardParked: false })).toBe("card");
	expect(resolveKeyOwner({ cardFocused: false, cardParked: true })).toBe("scrollback");
	expect(resolveKeyOwner({ cardFocused: false, cardParked: false, editorFocused: true })).toBe("composer");
	expect(resolveKeyOwner({ cardFocused: false, cardParked: false, editorFocused: false })).toBe("global");
});

test("Esc on a focused card parks; parked Esc is noop and never abort", () => {
	expect(nextEscStep({ cardFocused: true, cardParked: false, running: true })).toBe("park_card");
	expect(nextEscStep({ cardFocused: false, cardParked: true, running: true })).toBe("noop");
	expect(nextEscStep({ cardFocused: false, cardParked: false, running: true })).toBe("abort_turn");
	expect(nextEscStep(idle)).toBe("arm_rewind");
});

test("shortcuts stay consistent with the next Esc step", () => {
	const focused = shortcutRoutes({ cardFocused: true, cardParked: false, cardKind: "permission" });
	expect(focused.some((route) => route.keys.includes("esc") && route.label === "scrollback" && route.pinned)).toBe(true);
	const parked = shortcutRoutes({ cardFocused: false, cardParked: true, cardKind: "permission" });
	expect(parked.some((route) => route.pinned && route.label === "permission")).toBe(true);
});
