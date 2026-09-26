import { createAgent } from "../packages/core/src/sdk.ts";
import { scriptedResponses } from "./scripted-stream.ts";

// Run with: bun examples/turn-policy.ts (no credentials or network required).
const fixture = scriptedResponses([[{ type: "toolCall", id: "lookup-1", name: "lookup", arguments: {} }], [{ type: "text", text: "Unnecessary continuation" }]]);
let requests = 0;
const streamFn: typeof fixture.streamFn = (model, context, options) => { requests++; return fixture.streamFn(model, context, options); };
const agent = await createAgent({
	model: fixture.model, streamFn, cwd: process.cwd(), systemPrompt: "Find the requested record.",
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
