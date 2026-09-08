import { createAgent, RequestBus } from "../../packages/core/src/index.ts";
import { App } from "../../packages/tui/src/index.ts";
import { modelResponse } from "../../packages/core/test/helpers/model-response.ts";

let calls = 0;
const server = Bun.serve({
	hostname: "127.0.0.1", port: 0, fetch() {
		return ++calls === 1 ? new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "temporarily overloaded" } }), { status: 529 }) : modelResponse();
	}
});
const bus = new RequestBus({ timeoutMs: null });
const agent = await createAgent({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", baseUrl: server.url.toString(), systemPrompt: "", cwd: process.cwd(), requestBus: bus, retry: { baseDelayMs: 100 } });
const app = new App({
	host: "alt", requestBus: bus, cwd: process.cwd(), homeDir: process.cwd(), port: {
		async *runTurn(input) { const turn = agent.runTurn(input); yield* turn; process.send?.({ status: (await turn.result).status, calls }); },
		abort() { agent.abort(); }, getUsage() { return agent.getUsage(); },
	}
});
try { await app.start(); process.send?.("ready"); await app.waitUntilStopped(); }
finally { await agent.dispose(); server.stop(true); }
process.send?.({ raw: process.stdin.isRaw });
if (process.connected) process.disconnect?.();
