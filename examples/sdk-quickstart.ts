import { createAgent } from "../packages/core/src/sdk.ts";

const agent = await createAgent({
	provider: "xai",
	model: "grok-4.6",
	...(process.env.FORGE_AGENT_API_KEY ? { apiKey: process.env.FORGE_AGENT_API_KEY } : {}),
	systemPrompt: "Answer concisely.",
	cwd: process.cwd(),
});
try {
	for await (const event of agent.runTurn("Hello")) {
		if (event.type === "message_delta" && event.contentType === "text") {
			process.stdout.write(event.delta);
		}
	}
} finally {
	await agent.dispose();
}
