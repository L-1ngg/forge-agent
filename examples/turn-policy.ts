import { createAgent, type StreamFn } from "../packages/core/src/sdk.ts";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

// Run with: bun examples/turn-policy.ts (no credentials or network required).
const fixture = fauxProvider({ tokensPerSecond: 10_000 });
fixture.setResponses([fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-1" })]), fauxAssistantMessage([fauxText("Unnecessary continuation")])]);
const models = createModels(); models.setProvider(fixture.provider);
let requests = 0;
const streamFn: StreamFn = (model, context, options) => { requests++; return models.streamSimple(model, context, options); };
const agent = await createAgent({
	model: fixture.getModel(), streamFn, cwd: process.cwd(), systemPrompt: "Find the requested record.",
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
