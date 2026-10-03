import type { SkillsSnapshot } from "./skills/types.ts";
import type { PreparedSkills } from "./skills/source.ts";
import type { CreateAgentOptions } from "./agent.ts";
import type { Model } from "./model-types.ts";
import type { ModelAdapter } from "./model-adapter.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import type { SummaryDriver } from "./context/compaction.ts";
import type { McpManager, McpAssembly } from "./mcp/manager.ts";

export type ConfigurationPatch = { mcp?: import("./mcp/types.ts").McpConfiguration | false; } & Partial<Pick<CreateAgentOptions, "provider" | "model" | "adapter" | "apiKey" | "baseUrl" | "systemPrompt" | "thinkingLevel" | "tools" | "maxTokens" | "contextWindow" | "cacheHints" | "skills" | "memory">>;
export interface ConfigurationReceipt {
	accepted: true;
	revision: number;
	applied: Promise<{ status: "applied" | "canceled"; revision: number; }>;
}
export interface SessionConfiguration extends Omit<CreateAgentOptions, "model" | "adapter" | "thinkingLevel" | "storage"> {
	model: Model<string>;
	adapter?: ModelAdapter;
	thinkingLevel: NonNullable<CreateAgentOptions["thinkingLevel"]>;
	mcpManager?: McpManager;
}
export interface SessionAssembly {
	mcp?: McpAssembly;
	skills?: SkillsSnapshot;
	skillSources?: PreparedSkills;
	options: SessionConfiguration;
	driver: SummaryDriver & { isOverflow(message: SessionMessage): boolean; };
}
