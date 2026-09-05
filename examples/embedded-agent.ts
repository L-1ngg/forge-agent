import { createAgent, type AgentOptions } from "../packages/core/src/sdk.ts";
import type { HarnessTool } from "../packages/tools/src/index.ts";

const markerTool: HarnessTool<object, { marker: string }> = {
	name: "verification_marker",
	label: "Verification marker",
	description: "Return a fixed verification marker without external side effects.",
	parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	async execute() {
		return { ok: true, value: { marker: "SDK_EMBEDDED_OK" } };
	},
};

export async function runEmbeddedAgent(options: Pick<AgentOptions, "provider" | "model" | "apiKey" | "baseUrl">): Promise<void> {
	const agent = await createAgent({
		...options,
		cwd: process.cwd(),
		systemPrompt: "Follow the user request using only the supplied tools.",
		thinkingLevel: "off",
		tools: [markerTool],
		permission: { rules: [{ tool: markerTool.name, argsPattern: "*", effect: "allow" }] },
	});
	const timer = setTimeout(() => agent.abort(), 45_000);
	try {
		for await (const event of agent.runTurn("Call verification_marker once, then repeat the marker.")) {
			if (event.type === "message_delta" && event.contentType === "text") process.stdout.write(event.delta);
			if (event.type === "turn_end" && (event.stopReason === "error" || event.stopReason === "aborted")) {
				throw new Error(`Embedded agent ended with ${event.stopReason}`);
			}
		}
		process.stdout.write("\n");
	} finally {
		clearTimeout(timer);
		await agent.dispose();
	}
}

if (import.meta.main) {
	const provider = process.env.MYH_PROVIDER;
	const model = process.env.MYH_MODEL;
	if (!provider || !model) throw new Error("Set MYH_PROVIDER and MYH_MODEL explicitly");
	await runEmbeddedAgent({
		provider, model,
		...(process.env.MYH_API_KEY ? { apiKey: process.env.MYH_API_KEY } : {}),
		...(process.env.MYH_BASE_URL ? { baseUrl: process.env.MYH_BASE_URL } : {}),
	});
}
