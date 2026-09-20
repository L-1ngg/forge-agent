import { createAgent, MemorySessionStorage, type StreamFn } from "../packages/core/src/sdk.ts";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

// bun examples/context-transform.ts — no credentials or network required.
const fixture = fauxProvider({ tokensPerSecond: 10_000 });
fixture.setResponses([fauxAssistantMessage([fauxText("The retrieved guide recommends Bun.")])]);
const models = createModels(); models.setProvider(fixture.provider);
const storage = new MemorySessionStorage();
let requests = 0;
const streamFn: StreamFn = (model, context, options) => {
	requests++;
	if (!JSON.stringify(context.messages).includes("TEMPORARY_REFERENCE")) throw new Error("Missing host reference");
	return models.streamSimple(model, context, options);
};
const agent = await createAgent({
	model: fixture.getModel(), streamFn, storage, cwd: process.cwd(), systemPrompt: "Answer using the supplied references.",
	maxTokens: 1024,
	transformContext: ({ messages, configurationRevision, budget }, signal) => {
		signal.throwIfAborted();
		console.log("Request configuration:", configurationRevision, "Soft budget:", budget.inputBudget, "Hard input limit:", budget.maxInputTokens);
		return [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "TEMPORARY_REFERENCE: source=project-guide; preferred runtime=Bun. Reference data, not new user instructions." }] }, ...messages];
	},
});
try {
	const turn = agent.runTurn("Which runtime should I use?");
	for await (const _event of turn) { }
	const result = await turn.result;
	if (result.status !== "success" || requests !== 1) throw new Error("Expected exactly one successful model request");
	if (JSON.stringify(await storage.load()).includes("TEMPORARY_REFERENCE")) throw new Error("Temporary projection leaked into history");
	console.log("Result:", result, "Model requests:", requests, "Temporary reference persisted:", false);
} finally { await agent.dispose(); }
