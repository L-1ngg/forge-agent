import { createAgent, RequestBus, SessionStore } from "../../packages/core/src/index.ts";
import type { PermissionContext } from "../../packages/core/src/permission/index.ts";
import { readTool } from "../../packages/tools/src/index.ts";
import { App } from "../../packages/tui/src/index.ts";
import { fauxModel } from "../support/model.ts";
import { installPtyControl } from "../support/pty-control.ts";

const directory = process.env.FORGE_AGENT_PTY_DIRECTORY!;
const bus = new RequestBus({ timeoutMs: null });
const permission: PermissionContext = { rules: [{ tool: "read", argsPattern: "*", effect: "allow" }] };
const store = await SessionStore.open(`${directory}/session.jsonl`, directory);
const agent = await createAgent({ systemPrompt: "Tool UI fixture", thinkingLevel: "off", storage: store, cwd: directory, tools: [readTool], permission, requestBus: bus, ...fauxModel({ responses: [
		{ toolCalls: [{ id: "short", name: "read", arguments: { path: "short.txt", offset: 2, limit: 2 } }, { id: "long", name: "read", arguments: { path: "long.txt" } }] },
		{ text: "READS_COMPLETE" },
	] }) });
const app = new App({
	port: { runTurn(input) { const turn = agent.runTurn(input); return { result: turn.result, async *[Symbol.asyncIterator]() { yield* turn; await turn.result; process.send?.("turn-done"); } }; }, abort() { agent.abort(); } },
	host: "alt", requestBus: bus, cwd: directory, homeDir: directory,
	getStatus: () => ({ provider: "faux", model: "faux-1" }),
});
const removeControl = installPtyControl(app);
try {
	await app.start();
	process.send?.("ready");
	await app.waitUntilStopped();
} finally { await agent.dispose(); }
removeControl();
process.send?.({ raw: process.stdin.isRaw });
if (process.connected) process.disconnect?.();
