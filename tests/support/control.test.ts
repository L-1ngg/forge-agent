import { expect, test } from "bun:test";
import { barrier, nextTurn, waitFor } from "./control.ts";

test("observation waits for an asynchronous public condition and bounds a stalled predicate", async () => {
	let ready = false;
	void nextTurn().then(() => { ready = true; });
	await waitFor(() => ready, "ready");
	await expect(waitFor(() => false, "missing paint", { timeoutMs: 5, diagnostics: () => ({ output: "last frame" }) })).rejects.toThrow('Last observation: {"output":"last frame"}');
	const stalled = barrier("predicate");
	try { await expect(waitFor(() => stalled.wait().then(() => true), "stalled predicate", { timeoutMs: 5 })).rejects.toThrow("stalled predicate"); }
	finally { stalled.release(); }
});
