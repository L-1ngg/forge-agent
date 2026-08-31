import type { SessionEvent, SessionMessage } from "@myh/protocol";
import type { SessionStore } from "./session-store.ts";

export interface AgentPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	steer(input: string): void;
	followUp(input: string): void;
	abort(): void;
}

export class AgentRunner {
	constructor(
		private readonly port: AgentPort,
		private readonly store: SessionStore,
	) {}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		const messages: SessionMessage[] = [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }];
		let ended = false;
		let aborted = false;
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
		if (!aborted && hasPairedToolCalls(messages)) await this.store.appendTurn(messages);
	}

	steer(input: string): void {
		this.port.steer(input);
	}

	followUp(input: string): void {
		this.port.followUp(input);
	}

	abort(): void {
		this.port.abort();
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
