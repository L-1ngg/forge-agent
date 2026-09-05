import { App, dumpFrame } from "../../packages/tui/src/index.ts";
import { createAgent, createPiTestPort, RequestBus, SessionStore } from "../../packages/core/src/index.ts";
import { editTool } from "../../packages/tools/src/index.ts";

const directory = process.env.FORGE_AGENT_PTY_DIRECTORY!;
const bus = new RequestBus({ timeoutMs: null });
const store = await SessionStore.open(`${directory}/session.jsonl`, directory);
const agent = await createAgent({
	provider: "faux", model: "faux-1", systemPrompt: "PTY fixture", thinkingLevel: "off",
	storage: store.asStorage(), cwd: directory, tools: [editTool], permission: {}, requestBus: bus,
}, async (options) => createPiTestPort({
	...options,
	cwd: directory,
	tools: [editTool],
	permission: {}, requestBus: bus,
	responses: [
		{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "file.txt", old_text: "before", new_text: "after" } }] },
		{ text: "EDIT_COMPLETE" },
		{ text: "SLOW_RESPONSE_".repeat(50) },
	],
	tokensPerSecond: 40,
}));
const app = new App({
	port: agent, host: "alt", requestBus: bus,
	cwd: directory, homeDir: directory, getStatus: () => ({ provider: "faux", model: "faux-1" }),
});
const snapshots = new Map<string, ReturnType<typeof dumpFrame>>();
let snapshotName = 0;
// IPC keeps frame sampling on the event loop instead of a native signal callback.
const capture = (message: unknown) => {
	if (message !== "capture") return;
	snapshots.set(`frame-${snapshotName++}`, dumpFrame(app.composeFrameForTest()));
	process.send?.("captured");
};
process.on("message", capture);
try {
	await app.start();
	await app.waitUntilStopped();
} finally {
	await agent.dispose();
}
process.off("message", capture);
if (process.connected) process.disconnect();
await Bun.write(`${directory}/result.json`, JSON.stringify({ raw: process.stdin.isRaw, frames: [...snapshots.values()], pending: bus.pendingCount }));
