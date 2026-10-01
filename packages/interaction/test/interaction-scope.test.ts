import { expect, test } from "bun:test";
import { barrier, nextTurn, waitFor } from "../../../tests/support/control.ts";
import { InteractionScope } from "../src/interaction-scope.ts";

test("replacing an operation blocks its late progress, error and finally without releasing its successor", async () => {
	const scope = new InteractionScope(), old = barrier("old operation"), current = barrier("current operation");
	const events: string[] = [];
	let oldStarted = false, currentStarted = false;
	try {
		scope.run("read", "replace", { work: async (_signal, publish) => { oldStarted = true; await old.wait(); publish(() => events.push("old progress")); throw new Error("old error"); }, error: () => events.push("old error"), finish: () => events.push("old finally") });
		await waitFor(() => oldStarted, "old started");
		scope.run("read", "replace", { work: async () => { currentStarted = true; await current.wait(); return "current"; }, success: value => events.push(value), finish: () => events.push("current finally") });
		await waitFor(() => currentStarted, "current started"); old.release(); await nextTurn();
		expect(events).toEqual([]);
		expect(scope.run("read", "reject", { work: () => events.push("duplicate") })).toBe(false);
		current.release(); await waitFor(() => events.length === 2, "current settled");
		expect(events).toEqual(["current", "current finally"]);
	} finally { old.release(); current.release(); scope.dispose(); }
});

test("parent invalidation happens before abort listeners and runs every disposer", () => {
	const scope = new InteractionScope(), child = scope.child();
	const observations: boolean[] = [], disposed: string[] = [];
	child.signal.addEventListener("abort", () => observations.push(scope.active, child.active));
	scope.defer(() => { disposed.push("first"); throw new Error("cleanup"); });
	scope.defer(() => disposed.push("second"));
	expect(scope.dispose()).toHaveLength(1);
	expect(observations).toEqual([false, false]); expect(disposed).toEqual(["first", "second"]);
	expect(scope.dispose()).toEqual([]); expect(scope.child().active).toBe(false);
});

test("synchronous operation failures release their slot and remain observable", async () => {
	const scope = new InteractionScope(), errors: string[] = [];
	scope.run("management", "reject", { work() { throw new Error("sync failure"); }, error: error => errors.push(String(error)) });
	await waitFor(() => !scope.has("management"), "failure released slot");
	expect(errors).toEqual(["Error: sync failure"]); scope.dispose();
});
