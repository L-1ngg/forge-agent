import { AgentSession } from "../../packages/core/src/agent-session.ts";
import type { AgentPort } from "../../packages/core/src/agent-port.ts";
import type { ModelPortOptions } from "../../packages/core/src/session-port.ts";
import { createSummaryDriver } from "../../packages/core/src/session-configuration.ts";
import { fauxModel } from "./model.ts";

type TestPortOptions = Parameters<typeof fauxModel>[0] & Omit<ModelPortOptions, "model" | "streamFn" | "systemPrompt" | "thinkingLevel" | "cwd"> & { cwd?: string };

/** Direct internal-session fixture for low-level module tests; never an SDK factory. */
export function createTestPort(options: TestPortOptions): AgentPort {
	const { responses, tokensPerSecond, ...sessionOptions } = options;
	const configured: ModelPortOptions = {
		...sessionOptions,
		...fauxModel({ responses, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) }),
		systemPrompt: "execution contract test",
		thinkingLevel: "off",
		cwd: options.cwd ?? process.cwd(),
	};
	return new AgentSession({ options: configured, driver: createSummaryDriver(configured) }, async () => {
		throw new Error("Scripted provider does not support model reconfiguration");
	});
}
