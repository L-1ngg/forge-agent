import { createAgent } from "../../src/agent.ts";
import type { AgentPort } from "../../src/agent-port.ts";
import type { SessionStorage } from "../../src/session-storage.ts";
import type { RequestBus } from "../../src/request-bus.ts";
/** Exercises the public lifecycle with an explicitly controlled model port. */
export function createTestAgent(port: AgentPort, storage: SessionStorage, requestBus?: RequestBus) {
	return createAgent({ provider: "faux", model: "faux-1", systemPrompt: "", cwd: process.cwd(), storage, ...(requestBus ? { requestBus } : {}) }, () => port);
}
