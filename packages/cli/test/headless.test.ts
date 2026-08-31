import { expect, test } from "bun:test";
import { runHeadless } from "../src/headless.ts";

test("headless emits one valid JSON object per event", async () => {
	const lines: string[] = [];
	await runHeadless({
		runTurn: async function* () {
			yield { type: "agent_start", timestamp: 1 };
			yield { type: "agent_end", timestamp: 2 };
		},
		steer() {},
		followUp() {},
		abort() {},
	}, "hello", (line) => lines.push(line));
	expect(lines.map((line) => JSON.parse(line))).toEqual([
		{ type: "agent_start", timestamp: 1 },
		{ type: "agent_end", timestamp: 2 },
	]);
});
