import { createTestAgent } from "../support/test-agent.ts";
import { expect, test } from "bun:test";

test("native agent terminates a streamed turn with aborted then agent_end", async () => {
	const port = await createTestAgent({ responses: [{ text: "abcdefghijklmnopqrstuvwxyz" }], tokensPerSecond: 20 });
	const eventTypes: string[] = [];
	let stopReason: string | undefined;
	let requestedAbort = false;
	const turn = port.runTurn("abort");
	for await (const event of turn) {
		eventTypes.push(event.type);
		if (event.type === "message_delta" && !requestedAbort) { requestedAbort = true; port.abort(); }
		if (event.type === "turn_end") stopReason = event.stopReason;
	}
	expect(requestedAbort).toBe(true);
	expect(stopReason).toBe("aborted");
	expect(await turn.result).toEqual({ status: "aborted" });
	expect(eventTypes.at(-1)).toBe("agent_end");
});
