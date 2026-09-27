import { createAgent } from "../packages/core/src/sdk.ts";
import { scriptedResponses } from "./scripted-adapter.ts";

// Run with: bun examples/custom-adapter.ts
// This native TanStack adapter exercises the SDK without credentials or network access.
// Production hosts can pass any TanStack TextAdapter configured with their credentials.
const fixture = scriptedResponses([{ text: "Hello from the injected TanStack adapter." }]);
const agent = await createAgent({
	...fixture,
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
