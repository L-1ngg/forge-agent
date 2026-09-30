import { expect, test } from "bun:test";
import { testGroup } from "./test-offline.ts";
import { createTestPlan, type TestRegistry } from "./test-plan.ts";

test("test groups describe observable seams rather than historical filename prefixes", () => {
	expect(testGroup("packages/core/test/context-compaction.test.ts")).toBe("integration");
	expect(testGroup("packages/cli/test/session-ui-management.test.ts")).toBe("integration");
	expect(testGroup("packages/cli/test/startup.test.ts")).toBe("cli");
	expect(testGroup("packages/tui/test/width.test.ts")).toBe("contract");
});

const small: TestRegistry = { contract: ["module.test.ts"], integration: ["sdk.test.ts"], cli: ["cli.test.ts"] };
const paths = Object.values(small).flat();

test("test planning rejects missing, extra, duplicate and empty suites", () => {
	expect(createTestPlan(paths, small)).toEqual(small);
	expect(() => createTestPlan(paths.slice(1), small)).toThrow("missing");
	expect(() => createTestPlan([...paths, "forgotten.test.ts"], small)).toThrow("Unregistered");
	expect(() => createTestPlan(paths, { ...small, cli: ["module.test.ts"] })).toThrow("Duplicate");
	expect(() => createTestPlan(paths, { ...small, cli: [] })).toThrow("Empty");
	expect(() => createTestPlan(paths, { ...small, cli: ["cli.test.ts", "cli.test.ts"] })).toThrow("Duplicate");
});

test("the checked execution plan covers every discovered repository suite once", () => {
	const plan = createTestPlan();
	expect(new Set(Object.values(plan).flat()).size).toBe(Object.values(plan).flat().length);
});

test("an unregistered test cannot silently fall back to the contract group", () => {
	expect(() => testGroup("packages/core/test/new-behavior.test.ts")).toThrow("Unregistered test");
});
