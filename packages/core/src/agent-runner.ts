import type { SessionEvent, SessionMessage } from "@myh/protocol";
import type { UsageTruthPoint } from "./usage.ts";
import type { RequestBus } from "./request-bus.ts";
import type { SessionStore } from "./session-store.ts";

export interface AgentPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	steer(input: string): void;
	followUp(input: string): void;
	abort(): void;
	getUsage?(): UsageTruthPoint | undefined;
}

export class AgentRunner {
	private activeTurn: { aborted: boolean } | undefined;

	constructor(
		private readonly port: AgentPort,
		private readonly store: SessionStore,
		private readonly requestBus: RequestBus | undefined = undefined,
	) {}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		const turn = { aborted: false };
		this.activeTurn = turn;
		const messages: SessionMessage[] = [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }];
		let ended = false;
		let aborted = false;
		try {
			for await (const event of this.port.runTurn(input)) {
				if (event.type === "message_end" && event.message.role !== "user") {
					messages.push(event.message);
					if (event.message.stopReason === "aborted") aborted = true;
				}
				if (event.type === "turn_end" && event.stopReason === "aborted") aborted = true;
				if (event.type === "agent_end") ended = true;
				yield event;
			}
			if (!ended) throw new Error("Agent event stream ended without agent_end");
			if (!turn.aborted && !aborted && hasPairedToolCalls(messages)) await this.store.appendTurn(messages);
		} finally {
			if (this.activeTurn === turn) this.activeTurn = undefined;
		}
	}

	steer(input: string): void {
		this.port.steer(input);
	}

	followUp(input: string): void {
		this.port.followUp(input);
	}

	abort(): void {
		if (this.activeTurn) this.activeTurn.aborted = true;
		this.requestBus?.abort();
		this.port.abort();
	}

	getUsage(): UsageTruthPoint | undefined {
		return this.port.getUsage?.();
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
