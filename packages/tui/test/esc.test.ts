import { expect, test } from "bun:test";
import { EscController } from "../src/index.ts";

test("Esc prioritizes card pop, then abort, then idle double press", () => {
	let now = 1_000;
	const esc = new EscController({ now: () => now });
	expect(esc.press({ hasFocusedCard: true, running: true })).toBe("pop");
	expect(esc.press({ running: true })).toBe("abort");
	now += 500;
	expect(esc.press()).toBe("noop");
	now += 1_100;
	expect(esc.press()).toBe("arm");
	now += 500;
	expect(esc.press()).toBe("rewind");
});
