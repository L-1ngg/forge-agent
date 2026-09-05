import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import type { UsageTruthPoint } from "./usage.ts";
import type { RequestBus } from "./request-bus.ts";

export type InputAcceptance = { accepted: false } | { accepted: true; processed: Promise<boolean> };

export interface AgentPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	steer(input: string): InputAcceptance;
	followUp(input: string): InputAcceptance;
	abort(): void;
	getUsage?(): UsageTruthPoint | undefined;
}

export class AgentRunner {
	private activeTurn: { aborted: boolean; accepting: boolean } | undefined;
	private commitFailed = false;

	constructor(
		private readonly port: AgentPort,
		private readonly store: { appendTurn(messages: readonly SessionMessage[]): Promise<unknown> },
		private readonly requestBus: RequestBus | undefined = undefined,
	) {}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		this.assertHealthy();
		if (this.activeTurn) throw new Error("Agent runner is already processing a turn");
		const turn = { aborted: false, accepting: true };
		this.activeTurn = turn;
		const startedAt = Date.now();
		const messages: SessionMessage[] = [];
		let ended = false;
		let unsuccessful = false;
		try {
			for await (const event of this.port.runTurn(input)) {
				if (event.type === "message_end") {
					messages.push(event.message);
					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") unsuccessful = true;
				}
				if (event.type === "turn_end" && (event.stopReason === "aborted" || event.stopReason === "error")) unsuccessful = true;
				if (event.type === "agent_end") { ended = true; turn.accepting = false; }
				yield event;
			}
			if (!ended) throw new Error("Agent event stream ended without agent_end");
			if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: input }], timestamp: startedAt });
			if (!turn.aborted && !unsuccessful && hasPairedToolCalls(messages)) {
				try { await this.store.appendTurn(messages); }
				catch (error) {
					this.commitFailed = true;
					throw error;
				}
			}
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

	private assertHealthy(): void {
		if (this.commitFailed) throw new Error("Agent session commit failed; recreate the agent and reload storage before continuing");
	}
}

function hasPairedToolCalls(messages: readonly SessionMessage[]): boolean {
	const expected = new Set<string>();
	const completed = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "tool_call") expected.add(block.id);
		}
		if (message.role === "toolResult" && message.toolCallId) completed.add(message.toolCallId);
	}
	return [...expected].every((id) => completed.has(id));
}
