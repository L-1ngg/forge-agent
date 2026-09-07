import { createAgent, createPiTestPort, MemorySessionStorage, RequestBus } from "../../packages/core/src/index.ts";
import { App } from "../../packages/tui/src/index.ts";

const bus = new RequestBus({ timeoutMs: null });
const storage = new MemorySessionStorage([
	{ role: "user", timestamp: 1, content: [{ type: "text", text: "ORIGINAL_GOAL" }] },
	{ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "PREVIOUS_WORK" }] },
	{ role: "user", timestamp: 3, content: [{ type: "text", text: "RECENT_GOAL" }] },
]);
const agent = await createAgent({ provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd(), storage, requestBus: bus, context: { keepRecentTokens: 1 } }, (options) => createPiTestPort({ ...options, responses: [{ text: "PRIVATE_CHECKPOINT_SUMMARY" }, { text: "AFTER_COMPACT" }] }));
const app = new App({
	host: "alt", requestBus: bus, cwd: process.cwd(), homeDir: process.cwd(),
	port: {
		async *runTurn(input) { yield* agent.runTurn(input); process.send?.("task-done"); },
		async compact(instructions, emit) { const result = await agent.compact(instructions, emit); process.send?.({ compact: result.status }); return result; },
		abort() { agent.abort(); }, getUsage() { return agent.getUsage(); },
	},
});
try {
	await app.start(); process.send?.("ready"); await app.waitUntilStopped();
} finally { await agent.dispose(); }
process.send?.({ raw: process.stdin.isRaw, compactions: (await storage.load()).entries.filter((entry) => entry.type === "compaction").length });
if (process.connected) process.disconnect?.();
