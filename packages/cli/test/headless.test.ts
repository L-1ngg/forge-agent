import { expect, test } from "bun:test";
import { runHeadless } from "../src/headless.ts";
import { createPiTestPort } from "../../core/src/pi-port.ts";

test("headless emits one valid JSON object per event", async () => {
	const lines: string[] = [];
	await runHeadless({
		runTurn: async function* () {
			yield { type: "agent_start", timestamp: 1 };
			yield { type: "agent_end", timestamp: 2 };
		},
	}, "hello", (line) => lines.push(line));
	expect(lines.map((line) => JSON.parse(line))).toEqual([
		{ type: "agent_start", timestamp: 1 },
		{ type: "agent_end", timestamp: 2 },
	]);
});

test("headless reports a provider error as failure even when pi ends normally", async () => {
	const port = createPiTestPort({ responses: [{ stopReason: "error", errorMessage: "provider unavailable" }] });
	const lines: string[] = [];
	expect(await runHeadless(port, "hello", (line) => lines.push(line))).toBe(1);
	expect(lines.some((line) => JSON.parse(line).message?.errorMessage === "provider unavailable")).toBe(true);
});
