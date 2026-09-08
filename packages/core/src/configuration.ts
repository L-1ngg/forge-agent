import type { PiPortOptions, ModelPortOptions, ToolHooks } from "./pi-port.ts";
import type { AgentTool } from "./runtime/types.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import type { SummaryDriver } from "./context/compaction.ts";

export type ConfigurationPatch = Partial<Pick<PiPortOptions, "provider" | "model" | "apiKey" | "baseUrl" | "systemPrompt" | "thinkingLevel" | "tools" | "maxTokens" | "contextWindow">>;
export interface ConfigurationReceipt {
	accepted: true;
	revision: number;
	applied: Promise<{ status: "applied" | "canceled"; revision: number }>;
}
export interface SessionToolset extends ToolHooks { tools: AgentTool[]; clear(): void; }
export interface SessionAssembly {
	options: ModelPortOptions;
	toolset: SessionToolset;
	driver: SummaryDriver & { isOverflow(message: SessionMessage): boolean };
}
