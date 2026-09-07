import { App, dumpFrame } from "../../packages/tui/src/index.ts";
import { createAgent, createPiTestPort, RequestBus, SessionStore } from "../../packages/core/src/index.ts";
import { readTool } from "../../packages/tools/src/index.ts";
import type { PermissionContext } from "../../packages/core/src/permission/index.ts";

const directory = process.env.FORGE_AGENT_PTY_DIRECTORY!;
const bus = new RequestBus({ timeoutMs: null });
const permission: PermissionContext = { rules: [{ tool: "read", argsPattern: "*", effect: "allow" }] };
const store = await SessionStore.open(`${directory}/session.jsonl`, directory);
const agent = await createAgent({
	provider: "faux", model: "faux-1", systemPrompt: "Tool UI fixture", thinkingLevel: "off",
	storage: store.asStorage(), cwd: directory, tools: [readTool], permission, requestBus: bus,
}, async (options) => createPiTestPort({
	...options, cwd: directory, tools: [readTool], permission, requestBus: bus,
	responses: [
		{ toolCalls: [{ id: "short", name: "read", arguments: { path: "short.txt", offset: 2, limit: 2 } }, { id: "long", name: "read", arguments: { path: "long.txt" } }] },
		{ text: "READS_COMPLETE" },
	],
}));
const app = new App({
	port: { async *runTurn(input) { yield* agent.runTurn(input); process.send?.("turn-done"); }, abort() { agent.abort(); } },
	host: "alt", requestBus: bus, cwd: directory, homeDir: directory,
	getStatus: () => ({ provider: "faux", model: "faux-1" }),
});
const capture = (message: unknown) => {
	if (message === "capture") process.send?.({ frame: dumpFrame(app.composeFrameForTest()) });
};
process.on("message", capture);
try {
	await app.start();
	process.send?.("ready");
	await app.waitUntilStopped();
} finally { await agent.dispose(); }
process.off("message", capture);
process.send?.({ raw: process.stdin.isRaw });
if (process.connected) process.disconnect?.();
