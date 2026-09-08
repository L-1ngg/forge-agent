import type { ConfigurationPatch, ConfigurationReceipt } from "./configuration.ts";
import type { SessionEvent } from "@forge-agent/protocol";
import type { SessionStorage } from "./session-storage.ts";
import type { CompactionResult, ContextSettings } from "./context/compaction.ts";
import type { UsageTruthPoint } from "./usage.ts";

export type InputQueueMode = "all" | "one-at-a-time";
export interface InputQueueOptions { steeringMode?: InputQueueMode; followUpMode?: InputQueueMode; }

export type InputAcceptance = { accepted: false } | { accepted: true; processed: Promise<boolean> };

export interface AgentPort {
	updateConfiguration?(patch: ConfigurationPatch): Promise<ConfigurationReceipt>;
	dispose?(): Promise<void> | void;
	runTurn(input: string): AsyncIterable<SessionEvent>;
	continue?(): AsyncIterable<SessionEvent>;
	steer(input: string): InputAcceptance;
	followUp(input: string): InputAcceptance;
	abort(): void;
	getUsage?(): UsageTruthPoint | undefined;
	setStorage?(storage: SessionStorage): Promise<void>;
	compact?(instructions?: string, emit?: (event: SessionEvent) => void, signal?: AbortSignal): Promise<CompactionResult>;
	configureContext?(settings: Partial<ContextSettings>): void;
}
