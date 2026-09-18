import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Scenario, bounded } from "./scenario.ts";

test("scenario releases barriers, cleans resources in reverse order and removes isolated data", async () => {
	const scenario = await Scenario.open("cleanup");
	const release = scenario.gate("pending");
	const order: number[] = [];
	scenario.defer(() => { order.push(1); });
	scenario.defer(async () => { await release.wait(); order.push(2); throw new Error("cleanup fault"); });
	await expect(scenario.close()).rejects.toThrow("cleanup failed");
	expect(order).toEqual([2, 1]);
	expect(existsSync(scenario.directory)).toBe(false);
	await scenario.close();
});

test("barrier failures are bounded and diagnostics retain original error and ordered evidence", async () => {
	await expect(bounded(new Promise(() => {}), "never", 5)).rejects.toThrow("Timed out: never");
	const scenario = await Scenario.open("diagnostic");
	try {
		scenario.trace.record("request", { apiKey: "do-not-log", input: "test" });
		scenario.trace.record("save:start", { id: "entry" });
		const report = scenario.trace.format("diagnostic", new Error("original failure"));
		expect(report).toContain("original failure");
		expect(report).not.toContain("do-not-log");
		expect(JSON.parse(report).trace.map((entry: { kind: string }) => entry.kind)).toEqual(["request", "save:start"]);
	} finally { await scenario.close(); }
});
