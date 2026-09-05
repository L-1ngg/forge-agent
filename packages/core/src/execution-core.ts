import type { SessionEvent, SessionMessage, ToolCallBlock } from "@myh/protocol";
import type { AgentPort } from "./agent-runner.ts";
import { UsageTracker, type UsageTruthPoint } from "./usage.ts";

export interface ExecutionDriver {
	contextWindow: number;
	stream(messages: readonly SessionMessage[], signal: AbortSignal, emit: (event: SessionEvent) => void): Promise<SessionMessage>;
	execute(call: ToolCallBlock, signal: AbortSignal): Promise<{ message: SessionMessage; details?: unknown; terminate?: boolean }>;
	abortInteractions(): void;
}

class EventQueue implements AsyncIterable<SessionEvent> {
	private values: SessionEvent[] = [];
	private wake: (() => void) | undefined;
	private done = false;
	push(event: SessionEvent): void { this.values.push(event); this.wake?.(); }
	close(): void { this.done = true; this.wake?.(); }
	async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
		while (!this.done || this.values.length) {
			const event = this.values.shift();
			if (event) yield event;
			else await new Promise<void>((resolve) => { this.wake = resolve; });
		}
	}
}

export class ExecutionCore implements AgentPort {
	private messages: SessionMessage[];
	private steering: SessionMessage[] = [];
	private followups: SessionMessage[] = [];
	private controller: AbortController | undefined;
	private readonly usage: UsageTracker;

	constructor(private readonly driver: ExecutionDriver, history: readonly SessionMessage[] = []) {
		this.messages = structuredClone([...history]);
		this.usage = new UsageTracker({ contextWindow: driver.contextWindow });
		this.syncUsage();
	}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		if (this.controller) throw new Error("Agent is already processing a turn");
		const controller = new AbortController();
		this.controller = controller;
		const previousMessages = this.messages.slice();
		const queue = new EventQueue();
		this.usage.beginTurn();
		let completed = false;
		let consumed = false;
		let failed = false;
		const emit = (event: SessionEvent): void => { queue.push(structuredClone(event)); };
		const running = this.run(input, controller.signal, emit).then((success) => {
			failed = !success;
		}).finally(() => { completed = true; queue.close(); });
		try {
			for await (const event of queue) yield event;
			await running;
			consumed = true;
		} finally {
			if (!completed) this.abort();
			try { await running; } finally {
				if (!consumed || controller.signal.aborted || failed) {
					this.messages = previousMessages;
					this.steering = [];
					this.followups = [];
				}
				this.syncUsage();
				this.usage.endTurn();
				this.controller = undefined;
			}
		}
	}

	steer(input: string): void { this.steering.push(this.userMessage(input)); }
	followUp(input: string): void { this.followups.push(this.userMessage(input)); }
	abort(): void {
		if (!this.controller) return;
		this.controller.abort();
		this.driver.abortInteractions();
	}
	getUsage(): UsageTruthPoint { return this.usage.snapshot(); }

	private async run(input: string, signal: AbortSignal, emit: (event: SessionEvent) => void): Promise<boolean> {
		const timestamp = () => Date.now();
		const append = (message: SessionMessage): void => {
			this.messages.push(message);
			this.syncUsage();
			emit({ type: "message_end", message, timestamp: timestamp() });
		};
		const appendUser = (message: SessionMessage): void => {
			emit({ type: "message_start", message, timestamp: timestamp() });
			append(message);
		};
		emit({ type: "agent_start", timestamp: timestamp() });
		try {
			let pending = [this.userMessage(input)];
			while (true) {
				emit({ type: "turn_start", timestamp: timestamp() });
				for (const message of pending) appendUser(message);
				pending = [];
				signal.throwIfAborted();
				let assistant = await this.driver.stream(this.messages, signal, emit);
				if (signal.aborted) assistant = { ...assistant, stopReason: "aborted" };
				append(assistant);
				if (assistant.usage) this.usage.recordUsage(assistant.usage);
				const terminalFailure = assistant.stopReason === "error" || assistant.stopReason === "aborted";
				const calls = assistant.content.filter((content): content is ToolCallBlock => content.type === "tool_call");
				let terminate = false;
				if (!terminalFailure && assistant.stopReason !== "deferred") {
					const results = await Promise.all(calls.map(async (call) => {
						emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments, timestamp: timestamp() });
						let result: Awaited<ReturnType<ExecutionDriver["execute"]>>;
						let content: string;
						try {
							// Schema-valid arguments can still contain truncated content.
							if (assistant.stopReason === "length") throw new Error("Tool call skipped because the model output reached its token limit; arguments may be truncated.");
							result = await this.driver.execute(call, signal);
							content = JSON.stringify({ content: result.message.content, ...(result.details !== undefined ? { details: result.details } : {}) });
						} catch (error) {
							result = { message: { role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: timestamp(), isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
							content = JSON.stringify({ content: result.message.content });
						}
						emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content, isError: result.message.isError ?? false, timestamp: timestamp() });
						return result;
					}));
					terminate = results.length > 0 && results.every((result) => result.terminate === true);
					for (const result of results) {
						emit({ type: "message_start", message: result.message, timestamp: timestamp() });
						append(result.message);
					}
				}
				if (signal.aborted && assistant.stopReason !== "aborted") {
					assistant = { ...assistant, stopReason: "aborted" };
				}
				emit({ type: "turn_end", timestamp: timestamp(), ...(assistant.stopReason ? { stopReason: assistant.stopReason } : {}) });
				if (terminalFailure || signal.aborted) return false;
				if (assistant.stopReason === "deferred") return true;
				const steering = this.steering.shift();
				if (steering) pending.push(steering);
				if ((calls.length > 0 && !terminate) || pending.length) continue;
				const followup = this.followups.shift();
				if (followup) { pending.push(followup); continue; }
				return true;
			}
		} catch (error) {
			const message: SessionMessage = {
				role: "assistant", content: [], timestamp: timestamp(),
				stopReason: signal.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			emit({ type: "message_start", timestamp: timestamp(), message });
			append(message);
			emit({ type: "turn_end", timestamp: timestamp(), stopReason: message.stopReason! });
			return false;
		} finally {
			emit({ type: "agent_end", timestamp: timestamp() });
		}
	}

	private userMessage(input: string): SessionMessage {
		return { role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() };
	}
	private syncUsage(): void { this.usage.setContext({ messages: this.messages, contextWindow: this.driver.contextWindow }); }
}
