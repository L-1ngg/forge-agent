import { createAgent as createHostedAgent, type Agent, type CreateAgentOptions } from "./agent.ts";

export type { Agent, AgentTurn, AgentOptions, CreateAgentOptions } from "./agent.ts";
export type { InputAcceptance } from "./agent-runner.ts";
export { MemorySessionStorage, type SessionStorage } from "./session-storage.ts";
export type { PermissionContext } from "./permission/index.ts";
export type { UsageTruthPoint } from "./usage.ts";

export function createAgent(options: CreateAgentOptions): Promise<Agent> {
	return createHostedAgent(options);
}
