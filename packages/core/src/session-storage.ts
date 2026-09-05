import type { SessionMessage } from "@forge-agent/protocol";

export interface SessionStorage {
	load(): Promise<SessionMessage[]>;
	appendTurn(messages: readonly SessionMessage[]): Promise<void>;
}

export class MemorySessionStorage implements SessionStorage {
	private messages: SessionMessage[];

	constructor(history: readonly SessionMessage[] = []) {
		this.messages = structuredClone([...history]);
	}

	async load(): Promise<SessionMessage[]> {
		return structuredClone(this.messages);
	}

	async appendTurn(messages: readonly SessionMessage[]): Promise<void> {
		const added = structuredClone([...messages]);
		this.messages.push(...added);
	}
}
