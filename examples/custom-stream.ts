import { createAgent, type StreamFn } from "../packages/core/src/sdk.ts";
import { scriptedResponses } from "./scripted-stream.ts";

// Run with: bun examples/custom-stream.ts
// This local provider exercises the real SDK without credentials or network access.
const fixture = scriptedResponses([[{ type: "text", text: "Hello from the injected StreamFn." }]]);

// A host can resolve credentials or initialize its transport asynchronously here.
// Forward options, including signal, sessionId, maxTokens and maxRetries.
const streamFn: StreamFn = async (model, context, options) => fixture.streamFn(model, context, options);
const agent = await createAgent({
	model: fixture.model,
	streamFn,
	cwd: process.cwd(),
	systemPrompt: "Help with the task.",
});
try {
	const turn = agent.runTurn("Say hello.");
	for await (const event of turn) {
		if (event.type === "message_delta" && event.contentType === "text") process.stdout.write(event.delta);
	}
	console.log("\nResult:", (await turn.result).status);
} finally {
	await agent.dispose();
}
