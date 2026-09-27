import { afterEach } from "bun:test";
import { createAgent, type Agent, type CreateAgentOptions } from "../../packages/core/src/sdk.ts";
import { fauxModel } from "./model.ts";

type TestAgentOptions = Parameters<typeof fauxModel>[0] & Omit<CreateAgentOptions, "model" | "adapter" | "systemPrompt" | "thinkingLevel" | "cwd"> & { cwd?: string };

const agents = new Set<Agent>();
afterEach(async () => {
	const pending = [...agents];
	agents.clear();
	const results = await Promise.allSettled(pending.map(agent => agent.dispose()));
	const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
	if (failures.length) throw new AggregateError(failures, "Test agent cleanup failed");
});

/** Contract tests use the same public assembly and lifecycle as every host. */
export async function createTestAgent(options: TestAgentOptions) {
	const { responses, tokensPerSecond, ...agentOptions } = options;
	const agent = await createAgent({
		...agentOptions,
		...fauxModel({ responses, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) }),
		systemPrompt: "execution contract test",
		thinkingLevel: "off",
		cwd: options.cwd ?? process.cwd(),
	});
	agents.add(agent);
	return agent;
}
