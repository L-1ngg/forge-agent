import { createAgent as createHostedAgent, type Agent, type CreateAgentOptions } from "./agent.ts";

export type { Agent, AgentTurn, AgentOptions, CreateAgentOptions } from "./agent.ts";
export type { InputAcceptance } from "./agent-runner.ts";
export { MemorySessionStorage, type SessionStorage } from "./session-storage.ts";
export { SessionStore, type SessionDiagnostic, type SessionOpenOptions } from "./session-store.ts";
export type { SessionState, SessionEntry, MessageEntry, CompactionEntry } from "./session-storage.ts";
export type { PermissionContext } from "./permission/index.ts";
export type { UsageTruthPoint } from "./usage.ts";
export type { ContextSettings, CompactionResult, RetryPolicy } from "./context/compaction.ts";

export function createAgent(options: CreateAgentOptions): Promise<Agent> {
	return createHostedAgent(options);
}
