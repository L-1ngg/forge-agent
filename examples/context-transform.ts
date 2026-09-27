import { createAgent, MemorySessionStorage } from "../packages/core/src/sdk.ts";
import { scriptedResponses } from "./scripted-adapter.ts";

// bun examples/context-transform.ts — no credentials or network required.
const storage = new MemorySessionStorage();
let requests = 0;
const fixture = scriptedResponses([{ text: "The retrieved guide recommends Bun." }], request => {
	requests++;
	if (!JSON.stringify(request.messages).includes("TEMPORARY_REFERENCE")) throw new Error("Missing host reference");
});
const agent = await createAgent({
	...fixture, storage, cwd: process.cwd(), systemPrompt: "Answer using the supplied references.",
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
