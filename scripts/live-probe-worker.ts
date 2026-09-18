import { createAgent } from "../packages/core/src/sdk.ts";

// Credentials never enter this process; the budget proxy supplies authentication.
async function probe(): Promise<void> {
	let effects = 0;
	const agent = await createAgent({
		provider: process.env.FORGE_PROBE_PROVIDER!, model: process.env.FORGE_PROBE_MODEL!, apiKey: "probe-proxy-only", baseUrl: process.env.FORGE_PROBE_PROXY!,
		cwd: process.cwd(), systemPrompt: "This is an isolated protocol compatibility probe. Follow the requested tool call exactly.",
		context: { enabled: false }, retry: { maxRetries: 1, baseDelayMs: 0 }, maxTokens: 256,
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "probe_echo", label: "Probe", description: "Return the probe nonce; no external side effects.", parameters: { type: "object", properties: { nonce: { type: "string", const: "forge-probe" } }, required: ["nonce"], additionalProperties: false }, async execute(args) {
			if ((args as { nonce?: string }).nonce !== "forge-probe" || effects !== 0) throw new Error("Unexpected probe tool invocation");
			effects++; return { content: [{ type: "text", text: "forge-probe-ok" }], details: {} };
		} }],
	});
	try {
		const first = agent.runTurn('Call probe_echo once with nonce "forge-probe", then say done after receiving its result.');
		for await (const _event of first) { }
		if ((await first.result).status !== "success" || effects !== 1) throw new Error("Tool continuation failed");
		const second = agent.runTurn("Write a few sentences about counting. Do not call tools.");
		let canceled = false;
		for await (const event of second) if (!canceled && event.type === "message_delta") { canceled = true; agent.abort(); }
		if (!canceled || (await second.result).status !== "aborted") throw new Error("Streaming cancellation failed");
		console.log("PROBE_PASSED");
	} finally { await agent.dispose(); }
}

if (import.meta.main) {
	try { await probe(); } catch { process.exitCode = 1; }
}
