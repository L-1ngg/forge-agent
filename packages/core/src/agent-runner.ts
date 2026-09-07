import type { SessionEvent } from "@forge-agent/protocol";
import type { SessionStorage } from "./session-storage.ts";
import type { CompactionResult, ContextSettings } from "./context/compaction.ts";
import type { UsageTruthPoint } from "./usage.ts";
import type { RequestBus } from "./request-bus.ts";

export type InputAcceptance = { accepted: false } | { accepted: true; processed: Promise<boolean> };

export interface AgentPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	steer(input: string): InputAcceptance;
	followUp(input: string): InputAcceptance;
	abort(): void;
	getUsage?(): UsageTruthPoint | undefined;
	setStorage?(storage: SessionStorage): Promise<void>;
	compact?(instructions?: string, emit?: (event: SessionEvent) => void, signal?: AbortSignal): Promise<CompactionResult>;
	configureContext?(settings: Partial<ContextSettings>): void;
}

export class AgentRunner {
	private activeTurn: { aborted: boolean; accepting: boolean } | undefined;
	private commitFailed = false;

	constructor(
		private readonly port: AgentPort,
		private readonly store: SessionStorage,
		private readonly requestBus: RequestBus | undefined = undefined,
	) {}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		this.assertHealthy();
		if (this.activeTurn) throw new Error("Agent runner is already processing a turn");
		const turn = { aborted: false, accepting: true };
		this.activeTurn = turn;
		let ended = false;
		try {
			await this.port.setStorage?.(this.store);
			if (turn.aborted) { yield { type: "agent_end", timestamp: Date.now() }; return; }
			for await (const event of this.port.runTurn(input)) {
				if (event.type === "agent_end") { ended = true; turn.accepting = false; }
				yield event;
			}
			if (!ended) throw new Error("Agent event stream ended without agent_end");
		} catch (error) {
			this.commitFailed = true;
			throw error;
		} finally {
			if (this.activeTurn === turn) this.activeTurn = undefined;
		}
	}

	steer(input: string): InputAcceptance {
		this.assertHealthy();
		if (!this.activeTurn?.accepting || this.activeTurn.aborted) return { accepted: false };
		return this.port.steer(input);
	}

	followUp(input: string): InputAcceptance {
		this.assertHealthy();
		if (!this.activeTurn?.accepting || this.activeTurn.aborted) return { accepted: false };
		return this.port.followUp(input);
	}

	abort(): void {
		if (this.activeTurn) this.activeTurn.aborted = true;
		this.requestBus?.abort();
		this.port.abort();
	}

	getUsage(): UsageTruthPoint | undefined {
		return this.port.getUsage?.();
	}
	configureContext(settings: Partial<ContextSettings>): void { this.assertHealthy(); this.port.configureContext?.(settings); }
	async compact(instructions?: string, emit?: (event: SessionEvent) => void, signal?: AbortSignal): Promise<CompactionResult> {
		this.assertHealthy();
		if (this.activeTurn) throw new Error("Wait for active execution before compaction");
		if (!this.port.compact) throw new Error("Port does not support compaction");
		try { await this.port.setStorage?.(this.store); return await this.port.compact(instructions, emit, signal); }
		catch (error) { this.commitFailed = true; throw error; }
	}

	private assertHealthy(): void {
		if (this.commitFailed) throw new Error("Agent session commit failed; recreate the agent and reload storage before continuing");
	}
}
