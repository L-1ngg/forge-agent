import { MemoryManager } from "../../packages/cli/src/memory-command.ts";
import { RequestBus } from "../../packages/core/src/index.ts";
import { LongTermMemory, createAgent } from "../../packages/core/src/sdk.ts";
import { App } from "../../packages/tui/src/index.ts";
import { fauxModel } from "../support/model.ts";
import { installPtyControl } from "../support/pty-control.ts";
const root = process.env.FORGE_AGENT_PTY_DIRECTORY;
if (!root) throw new Error("Missing parent-owned PTY directory");
const store = new LongTermMemory({ project: root });
const manager = new MemoryManager({ store, autoUpdate: false, injection: false });
const bus = new RequestBus({ timeoutMs: null });
let calls = 0;
const agent = await createAgent({ cwd: root, systemPrompt: "", requestBus: bus, ...fauxModel({ responses: [{ text: "unexpected task" }] }) });
const app = new App({ host: "alt", cwd: root, homeDir: root, requestBus: bus,
	port: { runTurn(input) { const turn = agent.runTurn(input); return { result: turn.result, async *[Symbol.asyncIterator]() { calls++; yield* turn; } }; } },
	async memoryCommand(command) { const result = await manager.execute(command); process.send?.({ command, text: result.text }); return result; },
});
const removeControl = installPtyControl(app);
try { await app.start(); process.send?.("ready"); await app.waitUntilStopped(); }
finally { removeControl(); await agent.dispose(); process.send?.({ raw: process.stdin.isRaw, calls, files: await store.list("project") }); }
if (process.connected) process.disconnect?.();
