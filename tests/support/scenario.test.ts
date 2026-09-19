import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Scenario, bounded, withScenario } from "./scenario.ts";

test("scenario rejects a missing request without an explicit completeness assertion", async () => {
	await expect(withScenario("missing-owned-request", async scenario => {
		scenario.httpFixture("owned", [{ id: "required", method: "POST", path: "/messages", match() {}, response: { chunks: ["ok"] } }]);
	})).rejects.toThrow("missing exchanges: required");
});

test("scenario releases barriers, cleans resources in reverse order and removes isolated data", async () => {
	const scenario = await Scenario.open("cleanup");
	const release = scenario.gate("pending");
	const order: number[] = [];
	scenario.defer(() => { order.push(1); });
	scenario.defer(async () => { await release.wait(); order.push(2); throw new Error("cleanup fault"); });
	await expect(scenario.close()).rejects.toThrow("cleanup failed");
	expect(order).toEqual([2, 1]);
	expect(existsSync(scenario.directory)).toBe(false);
	await expect(scenario.close()).rejects.toThrow("cleanup failed");
	expect(order).toEqual([2, 1]);
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

const exchange = (end?: "close" | "disconnect" | "hold") => ({ id: "one", method: "POST", path: "/messages", match(body: unknown) { expect(body).toEqual({ input: "test" }); }, response: { chunks: ["partial"], ...(end ? { end } : {}) } });
const post = (url: string, path = "messages") => fetch(new URL(path, url), { method: "POST", body: JSON.stringify({ input: "test" }) });

for (const kind of ["unmatched", "extra", "late-extra"] as const) test(`scenario rejects ${kind} requests automatically`, async () => {
	await expect(withScenario(kind, async scenario => {
		const fixture = scenario.httpFixture(kind, [exchange()]);
		await (await post(fixture.url, kind === "unmatched" ? "wrong" : "messages")).text();
		if (kind === "extra") await (await post(fixture.url)).text();
		if (kind === "late-extra") scenario.defer(async () => { await (await post(fixture.url)).text(); });
	})).rejects.toThrow(kind === "unmatched" ? "Unexpected POST /wrong" : "exhausted");
});

for (const end of ["disconnect", "hold"] as const) test(`scenario accepts declared ${end} without demanding complete response delivery`, async () => {
	await withScenario(end, async scenario => {
		const fixture = scenario.httpFixture(end, [exchange(end)]);
		const response = await post(fixture.url);
		if (end === "hold") await response.body!.cancel();
		else await response.text().catch(() => {});
	});
});

test("scenario retains the assertion as primary and diagnoses all settlement failures", async () => {
	const { spyOn } = await import("bun:test");
	const lines: unknown[][] = [];
	const logger = spyOn(console, "error").mockImplementation((...args) => { lines.push(args); });
	const primary = new Error("business assertion failed");
	let directory = "";
	let remainingCleaned = false;
	try {
		await expect(withScenario("both-fail", async scenario => {
			directory = scenario.directory;
			scenario.httpFixture("missing", [exchange()]);
			scenario.defer(() => { remainingCleaned = true; });
			scenario.defer(() => { throw new Error("disposal failed"); });
			throw primary;
		})).rejects.toBe(primary);
		expect(remainingCleaned).toBe(true);
		expect(existsSync(directory)).toBe(false);
		expect(JSON.stringify(lines)).toContain("disposal failed");
		expect(JSON.stringify(lines)).toContain("missing exchanges: one");
	} finally { logger.mockRestore(); }
});

test("scenario waits for owned execution and shares concurrent close settlement", async () => {
	const scenario = await Scenario.open("owned-cleanup");
	const gate = scenario.gate("release-owned-execution");
	const fixture = scenario.httpFixture("final-request", [exchange()]);
	let completed = false;
	const running = scenario.collect((async function* () {
		await gate.wait();
		await (await post(fixture.url)).text();
		completed = true;
	})());
	const first = scenario.close();
	expect(scenario.close()).toBe(first);
	await first;
	await running;
	expect(completed).toBe(true);
	expect(existsSync(scenario.directory)).toBe(false);
	await expect(post(fixture.url)).rejects.toThrow();
});

test("scenario still closes every fixture after verification and cleanup fail", async () => {
	const scenario = await Scenario.open("close-all");
	const fixtures = [scenario.httpFixture("missing-one", [exchange()]), scenario.httpFixture("missing-two", [exchange()])];
	scenario.defer(() => { throw new Error("disposer failure"); });
	await expect(scenario.close()).rejects.toThrow("missing-one");
	for (const fixture of fixtures) await expect(post(fixture.url)).rejects.toThrow();
	expect(existsSync(scenario.directory)).toBe(false);
});

test("scenario cancels and drains an owned SDK invocation before fixture verification", async () => {
	let turn: import("../../packages/core/src/sdk.ts").AgentTurn | undefined;
	let running: Promise<unknown> | undefined;
	await withScenario("cancel-owned-agent", async scenario => {
		const fixture = scenario.httpFixture("held-response", [{ id: "held", method: "POST", path: "/v1/messages", match() {}, response: { chunks: [], end: "hold" } }]);
		const agent = await scenario.agent({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fake-test", baseUrl: fixture.url });
		turn = agent.runTurn("cancel on close");
		running = scenario.collect(turn);
		await fixture.received(1);
	});
	await running;
	expect(await turn!.result).toEqual({ status: "aborted" });
});

test("scenario cannot lose an execution failure while awaiting other cleanup", async () => {
	await expect(withScenario("failed-owned-execution", async scenario => {
		const gate = scenario.gate("release-on-close");
		void scenario.collect((async function* () {
			await gate.wait();
			throw new Error("owned execution failed");
		})());
		scenario.defer(async () => { await Promise.resolve(); });
	})).rejects.toThrow("owned execution failed");
});
