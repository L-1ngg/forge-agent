import { App, frameToText } from "../../packages/tui/src/index.ts";
import { createAgent, createPiTestPort, MemorySessionStorage, RequestBus } from "../../packages/core/src/index.ts";
import type { SessionEvent } from "../../packages/protocol/src/index.ts";

const bus = new RequestBus({ timeoutMs: null });
const storage = new MemorySessionStorage();
let releaseCommit!: () => void;
const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
let commits = 0;
const calls: string[] = [];
const agent = await createAgent({
	provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd(), requestBus: bus,
	storage: {
		load: () => storage.load(),
		async appendTurn(messages) {
			if (++commits === 1) {
				process.send?.({ type: "saving" });
				await commitGate;
				if (process.env.MYH_PTY_FAIL_COMMIT === "1") throw new Error("injected disk failure");
			}
			await storage.appendTurn(messages);
		},
	},
}, (options) => createPiTestPort({ ...options, responses: [{ text: "FIRST_COMPLETE" }, { text: "NEXT_COMPLETE" }, { text: "LAST_COMPLETE" }] }));
const app = new App({
	port: {
		async *runTurn(input): AsyncIterable<SessionEvent> {
			calls.push(input);
			try { yield* agent.runTurn(input); }
			finally { process.send?.({ type: "settled", calls: [...calls] }); }
		},
		abort: () => agent.abort(),
		getUsage: () => agent.getUsage(),
	},
	host: "alt", requestBus: bus, cwd: process.cwd(), homeDir: process.cwd(), getStatus: () => ({ provider: "faux", model: "faux-1" }),
});
process.on("message", (message) => {
	if (message === "commit") releaseCommit();
	if (message === "frame") process.send?.({ type: "frame", text: frameToText(app.composeFrameForTest()), calls: [...calls] });
});
try {
	await app.start();
	process.send?.({ type: "ready" });
	await app.waitUntilStopped();
} finally { await agent.dispose(); }
process.send?.({ type: "result", raw: process.stdin.isRaw, pending: bus.pendingCount, calls, messages: await storage.load() });
process.disconnect?.();
