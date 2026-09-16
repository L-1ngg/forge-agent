import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongTermMemory, createAgent } from "../../packages/core/src/sdk.ts";
import { createPiTestPort, RequestBus } from "../../packages/core/src/index.ts";
import { MemoryManager } from "../../packages/cli/src/memory-command.ts";
import { App } from "../../packages/tui/src/index.ts";
const root = await mkdtemp(join(tmpdir(), "forge-memory-pty-"));
const store = new LongTermMemory({ project: root });
const manager = new MemoryManager({ store, autoUpdate: false, injection: false });
const bus = new RequestBus({ timeoutMs: null });
let calls = 0;
const agent = await createAgent({ provider: "faux", model: "faux-1", cwd: root, systemPrompt: "", requestBus: bus }, options => createPiTestPort({ ...options, responses: [{ text: "unexpected task" }] }));
const app = new App({ host: "alt", cwd: root, homeDir: root, requestBus: bus,
	port: { async *runTurn(input) { calls++; yield* agent.runTurn(input); } },
	async memoryCommand(command) { const result = await manager.execute(command); process.send?.({ command, text: result.text }); return result; },
});
try { await app.start(); process.send?.("ready"); await app.waitUntilStopped(); }
finally { await agent.dispose(); process.send?.({ raw: process.stdin.isRaw, calls, files: await store.list("project") }); await rm(root, { recursive: true, force: true }); }
if (process.connected) process.disconnect?.();
