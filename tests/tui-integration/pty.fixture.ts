import { createAgent, RequestBus, SessionStore } from "../../packages/core/src/index.ts";
import { editTool } from "../../packages/tools/src/index.ts";
import { App, dumpFrame } from "../../packages/tui/src/index.ts";
import { fauxModel } from "../support/model.ts";
import { installPtyControl } from "../support/pty-control.ts";

const directory = process.env.FORGE_AGENT_PTY_DIRECTORY!;
const bus = new RequestBus({ timeoutMs: null });
const store = await SessionStore.open(`${directory}/session.jsonl`, directory);
const agent = await createAgent({ systemPrompt: "PTY fixture", thinkingLevel: "off", storage: store, cwd: directory, tools: [editTool], permission: {}, requestBus: bus, ...fauxModel({ responses: [
		{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "file.txt", old_text: "before", new_text: "after" } }] },
		{ text: "EDIT_COMPLETE" },
		{ text: "SLOW_RESPONSE_".repeat(50) },
	], tokensPerSecond: 40 }) });
const app = new App({
	port: agent, host: "alt", requestBus: bus,
	cwd: directory, homeDir: directory, getStatus: () => ({ provider: "faux", model: "faux-1" }),
});
const snapshots = new Map<string, ReturnType<typeof dumpFrame>>();
const removeControl = installPtyControl(app, frame => snapshots.set(`${frame.columns}x${frame.rows}`, frame));
try {
	await app.start();
	await app.waitUntilStopped();
} finally {
	await agent.dispose();
}
removeControl();
if (process.connected) process.disconnect?.();
await Bun.write(`${directory}/result.json`, JSON.stringify({ raw: process.stdin.isRaw, frames: [...snapshots.values()], pending: bus.pendingCount }));
