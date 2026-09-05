import { App, dumpFrame } from "../../packages/tui/src/index.ts";
import { AgentRunner, createPiTestPort, RequestBus, SessionStore } from "../../packages/core/src/index.ts";
import { editTool } from "../../packages/tools/src/index.ts";

const directory = process.env.MYH_PTY_DIRECTORY!;
const bus = new RequestBus({ timeoutMs: null });
const store = await SessionStore.open(`${directory}/session.jsonl`, directory);
const port = createPiTestPort({
	cwd: directory,
	tools: [editTool],
	permission: {}, requestBus: bus,
	responses: [
		{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "file.txt", old_text: "before", new_text: "after" } }] },
		{ text: "EDIT_COMPLETE" },
		{ text: "SLOW_RESPONSE_".repeat(50) },
	],
	tokensPerSecond: 40,
});
const app = new App({
	port: new AgentRunner(port, store, bus), host: "alt", requestBus: bus,
	cwd: directory, homeDir: directory, getStatus: () => ({ provider: "faux", model: "faux-1" }),
});
const snapshots = new Map<string, ReturnType<typeof dumpFrame>>();
let snapshotName = 0;
const capture = () => snapshots.set(`frame-${snapshotName++}`, dumpFrame(app.composeFrameForTest()));
process.on("SIGUSR1", capture);
await app.start();
await app.waitUntilStopped();
process.off("SIGUSR1", capture);
await Bun.write(`${directory}/result.json`, JSON.stringify({ raw: process.stdin.isRaw, frames: [...snapshots.values()], pending: bus.pendingCount }));
