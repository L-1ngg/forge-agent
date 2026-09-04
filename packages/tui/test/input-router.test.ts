import { expect, test } from "bun:test";
import { nextEscStep, resolveKeyOwner, shortcutRoutes } from "../src/index.ts";

test("key owner priority gives cards precedence and parked cards scrollback ownership", () => {
	expect(resolveKeyOwner({ cardFocused: true, cardParked: true, editorFocused: true })).toBe("card");
	expect(resolveKeyOwner({ cardFocused: false, cardParked: true, editorFocused: true })).toBe("scrollback");
	expect(resolveKeyOwner({ cardFocused: false, cardParked: false, editorFocused: true })).toBe("composer");
});

test("Esc parks a focused card and never aborts a running turn after park", () => {
	expect(nextEscStep({ cardFocused: true, cardParked: false, running: true })).toBe("park_card");
	expect(nextEscStep({ cardFocused: false, cardParked: true, running: true })).toBe("noop");
	expect(nextEscStep({ cardFocused: false, cardParked: false, running: true })).toBe("abort_turn");
});

test("shortcut routes expose the same pinned route as the key owner", () => {
	const routes = shortcutRoutes({ cardFocused: false, cardParked: true, cardKind: "permission", editorFocused: true });
	expect(routes.some((route) => route.pinned && route.keys.includes("Tab"))).toBe(true);
	expect(routes[0]?.label).toBe("permission");
	expect(shortcutRoutes({ cardFocused: true, cardParked: false }).find((route) => route.keys.includes("Esc"))?.label).toBe("scrollback");
	expect(shortcutRoutes({ cardFocused: true, cardParked: false, cardSubInput: true }).find((route) => route.keys.includes("Esc"))?.label).toBe("back");
});

test("parked card routes name every protocol request kind", () => {
	const labels = (["permission", "cancel_confirm", "question", "plan_approval", "oauth"] as const).map((cardKind) =>
		shortcutRoutes({ cardFocused: false, cardParked: true, cardKind })[0]?.label,
	);
	expect(labels).toEqual(["permission", "cancel turn", "question", "plan approval", "oauth"]);
});
