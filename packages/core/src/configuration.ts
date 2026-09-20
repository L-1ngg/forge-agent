import type { SkillsSnapshot } from "./skills/types.ts";
import type { PiPortOptions, ModelPortOptions, ToolHooks } from "./pi-port.ts";
import type { AgentTool } from "./runtime/types.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import type { SummaryDriver } from "./context/compaction.ts";

export type ConfigurationPatch = Partial<Pick<PiPortOptions, "provider" | "model" | "streamFn" | "apiKey" | "baseUrl" | "systemPrompt" | "thinkingLevel" | "tools" | "maxTokens" | "contextWindow" | "skills">>;
export interface ConfigurationReceipt {
	accepted: true;
	revision: number;
	applied: Promise<{ status: "applied" | "canceled"; revision: number }>;
}
export interface SessionToolset extends ToolHooks { tools: AgentTool[]; clear(): void; }
export interface SessionAssembly {
	skills?: SkillsSnapshot;
	options: ModelPortOptions;
	driver: SummaryDriver & { isOverflow(message: SessionMessage): boolean };
}
