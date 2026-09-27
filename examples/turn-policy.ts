import { createAgent } from "../packages/core/src/sdk.ts";
import { scriptedResponses } from "./scripted-adapter.ts";

// Run with: bun examples/turn-policy.ts (no credentials or network required).
let requests = 0;
const fixture = scriptedResponses([
	{ toolCalls: [{ id: "lookup-1", name: "lookup", arguments: {} }] },
	{ text: "Unnecessary continuation" },
], () => { requests++; });
const agent = await createAgent({
	...fixture, cwd: process.cwd(), systemPrompt: "Find the requested record.",
	permission: { rules: [{ tool: "lookup", argsPattern: "*", effect: "allow" }] },
	tools: [{ name: "lookup", label: "Lookup", description: "Find a record", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		async execute() { return { content: [{ type: "text", text: "Target record found" }], details: { id: "record-42" } }; } }],
	shouldStopAfterTurn: ({ toolResults, turnIndex, usage }) => {
		console.log("Completed round:", turnIndex, "Reported cost:", usage.costUsd ?? "unknown");
		return toolResults.some(result => result.toolName === "lookup" && !result.isError);
	},
});
try {
	const turn = agent.runTurn("Look up record 42.");
	for await (const _event of turn) { }
	const result = await turn.result;
	console.log("Result:", result, "Model requests:", requests);
	if (requests !== 1 || result.status !== "success" || result.terminationReason !== "policy") throw new Error("Expected policy stop after exactly one request");
} finally { await agent.dispose(); }
