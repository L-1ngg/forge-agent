import type { SessionEvent, SessionMessage, ToolCallBlock } from "@forge-agent/protocol";
import type { AgentPort, InputAcceptance } from "./agent-runner.ts";
import { UsageTracker, type UsageTruthPoint } from "./usage.ts";
import { MemorySessionStorage, messageEntry, projectMessages, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { buildContext, DEFAULT_CONTEXT, generateCompaction, prepareCompaction, type CompactionReason, type CompactionResult, type ContextSettings, type SummaryDriver } from "./context/compaction.ts";
import { randomUUID } from "node:crypto";

export interface ExecutionDriver extends SummaryDriver {
	contextWindow: number;
	contextIdentity?: string;
	fixedText?: string;
	isOverflow?(message: SessionMessage): boolean;
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

interface QueuedInput {
	message: SessionMessage;
	processed: (value: boolean) => void;
}

export class ExecutionCore implements AgentPort {
	private messages: SessionMessage[];
	private steering: QueuedInput[] = [];
	private followups: QueuedInput[] = [];
	private accepting = false;
	private controller: AbortController | undefined;
	private readonly usage: UsageTracker;
	private storage: SessionStorage;
	private state: SessionState = { entries: [], leafId: null };
	private initialized = false;
	private faulted = false;
	private settings: ContextSettings;
	private recoveryUsed = false;

	constructor(private readonly driver: ExecutionDriver, history: readonly SessionMessage[] = [], settings: Partial<ContextSettings> = {}) {
		this.settings = { ...DEFAULT_CONTEXT, ...settings };
		this.messages = structuredClone([...history]);
		this.storage = new MemorySessionStorage(history);
		this.usage = new UsageTracker({ contextWindow: driver.contextWindow });
		this.configureContext(settings);
		this.syncUsage();
	}

	async setStorage(storage: SessionStorage): Promise<void> {
		if (this.controller) throw new Error("Cannot replace storage during execution");
		if (this.initialized && this.storage === storage) return;
		const state = await storage.load();
		const messages = buildContext(state);
		this.storage = storage;
		this.state = structuredClone(state);
		this.messages = messages;
		this.initialized = true;
		this.usage.invalidate();
		this.syncUsage();
	}

	async *runTurn(input: string): AsyncIterable<SessionEvent> {
		if (this.faulted) throw new Error("Agent is faulted; recreate it from storage");
		if (this.controller) throw new Error("Agent is already processing a turn");
		if (!this.initialized) await this.setStorage(this.storage);
		const controller = new AbortController();
		this.controller = controller;
		this.accepting = true;
		const queue = new EventQueue();
		this.usage.beginTurn();
		let completed = false;
		let failure: unknown;
		const emit = (event: SessionEvent): void => { queue.push(structuredClone(event)); };
		const running = this.run(input, controller.signal, emit).catch((error: unknown) => { failure = error; }).finally(() => { completed = true; queue.close(); });
		try {
			for await (const event of queue) yield event;
			await running;
		} finally {
			if (!completed) this.abort();
			try { await running; } finally {
				this.syncUsage();
				this.usage.endTurn();
				this.controller = undefined;
				if (failure !== undefined) throw failure;
			}
		}
	}

	steer(input: string): InputAcceptance { return this.enqueue(input, this.steering); }
	followUp(input: string): InputAcceptance { return this.enqueue(input, this.followups); }
	private enqueue(input: string, queue: QueuedInput[]): InputAcceptance {
		if (this.faulted) throw new Error("Agent is faulted; recreate it from storage");
		if (!this.accepting) return { accepted: false };
		const processed = new Promise<boolean>((resolve) => { queue.push({ message: this.userMessage(input), processed: resolve }); });
		return { accepted: true, processed };
	}
	private closeInput(): void {
		this.accepting = false;
		for (const input of [...this.steering, ...this.followups]) input.processed(false);
		this.steering = [];
		this.followups = [];
	}
	abort(): void {
		if (!this.controller) return;
		this.closeInput();
		this.controller.abort();
		this.driver.abortInteractions();
	}
	getUsage(): UsageTruthPoint { return this.usage.snapshot(); }
	configureContext(settings: Partial<ContextSettings>): void {
		if (this.controller) throw new Error("Cannot configure context during execution");
		const next = { ...this.settings, ...settings };
		if (!Number.isInteger(next.reserveTokens) || next.reserveTokens < 1 || !Number.isInteger(next.keepRecentTokens) || next.keepRecentTokens < 1 || typeof next.enabled !== "boolean" || !["inherit", "off"].includes(next.summaryReasoning)) throw new Error("Invalid context settings");
		this.settings = next;
	}

	async compact(instructions?: string, emit: (event: SessionEvent) => void = () => {}, signal?: AbortSignal): Promise<CompactionResult> {
		if (this.faulted) throw new Error("Agent is faulted; recreate it from storage");
		if (this.controller) throw new Error("Wait for active execution before compaction");
		if (!this.initialized) await this.setStorage(this.storage);
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		this.controller = controller;
		try { return await this.compactContext("manual", controller.signal, emit, instructions); }
		finally { signal?.removeEventListener("abort", abort); this.controller = undefined; }
	}
	private async compactContext(reason: CompactionReason, signal: AbortSignal, emit: (event: SessionEvent) => void, instructions?: string): Promise<CompactionResult> {
		const operationId = randomUUID();
		const beforeTokens = this.getUsage().contextTokens ?? 0;
		const event = (phase: "start" | "end" | "error" | "skipped", extra: { afterTokens?: number; error?: string; usage?: NonNullable<SessionMessage["usage"]> } = {}) => emit({ type: "compaction", phase, reason, operationId, beforeTokens, timestamp: Date.now(), ...extra });
		try {
			signal.throwIfAborted();
			const plan = prepareCompaction(this.state, this.settings);
			if (!plan) { event("skipped"); return { status: "skipped", operationId, beforeTokens }; }
			event("start");
			const result = await generateCompaction(plan, this.settings, this.driver, signal, instructions, (details) => emit({ type: "compaction", operationId, reason, beforeTokens, timestamp: Date.now(), ...details }));
			signal.throwIfAborted();
			const entry = { type: "compaction" as const, id: randomUUID(), parentId: this.state.leafId, timestamp: new Date().toISOString(), summary: result.summary, firstKeptEntryId: plan.firstKeptEntryId, tokensBefore: beforeTokens, details: plan.details, ...(result.usage ? { usage: result.usage } : {}) };
			await this.persistEntry(entry);
			this.messages = buildContext(this.state);
			this.usage.invalidate(); this.syncUsage();
			const afterTokens = this.getUsage().contextTokens ?? 0;
			event("end", { afterTokens, ...(result.usage ? { usage: result.usage } : {}) });
			return { status: "complete", operationId, beforeTokens, afterTokens };
		} catch (error) {
			if (this.faulted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			event("error", { error: message });
			return { status: "error", operationId, beforeTokens, error: message };
		}
	}

	private async run(input: string, signal: AbortSignal, emit: (event: SessionEvent) => void): Promise<boolean> {
		const timestamp = () => Date.now();
		const append = async (message: SessionMessage): Promise<void> => {
			emit({ type: "message_end", message, timestamp: timestamp() });
			const entry = messageEntry(message, this.state.leafId);
			await this.persistEntry(entry);
			this.messages.push(message);
		};
		const appendUser = async (message: SessionMessage): Promise<void> => {
			emit({ type: "message_start", message, timestamp: timestamp() });
			await append(message);
		};
		emit({ type: "agent_start", timestamp: timestamp() });
		try {
			let pending: QueuedInput[] = [{ message: this.userMessage(input), processed() {} }];
			while (true) {
				signal.throwIfAborted();
				emit({ type: "turn_start", timestamp: timestamp() });
				for (const input of pending) { this.recoveryUsed = false; input.processed(true); await appendUser(input.message); }
				pending = [];
				signal.throwIfAborted();
				this.syncUsage();
				if (this.settings.enabled && (this.getUsage().contextTokens ?? 0) > this.driver.contextWindow - this.settings.reserveTokens) await this.compactContext("threshold", signal, emit);
				signal.throwIfAborted();
				const requestMessages = projectMessages(this.messages);
				let assistant = await this.driver.stream(requestMessages, signal, emit);
				if (signal.aborted) assistant = { ...assistant, stopReason: "aborted" };
				const recoverableLength = assistant.stopReason === "length" && (this.driver.maxTokens ?? 0) > 0 && assistant.usage !== undefined && assistant.usage.output < this.driver.maxTokens!;
				if (this.settings.enabled && recoverableLength) assistant = { ...assistant, contextExcluded: true };
				await append(assistant);
				this.syncUsage([...requestMessages, assistant]);
				if (assistant.usage) this.usage.recordUsage(assistant.usage);
				const overflow = this.driver.isOverflow?.(assistant) ?? false;
				if (this.settings.enabled && !signal.aborted && ((assistant.stopReason === "error" && overflow) || recoverableLength)) {
					emit({ type: "turn_end", timestamp: timestamp(), stopReason: assistant.stopReason! });
					if (this.recoveryUsed) return false;
					this.recoveryUsed = true;
					const reason = recoverableLength ? "length" : "overflow";
					emit({ type: "recovery", operationId: randomUUID(), reason, attempt: 1, timestamp: timestamp() });
					const result = await this.compactContext(reason, signal, emit);
					if (result.status !== "complete" || signal.aborted) return false;
					continue;
				}
				if (assistant.stopReason !== "error" && assistant.stopReason !== "length" && assistant.stopReason !== "aborted") this.recoveryUsed = false;
				const terminalFailure = assistant.stopReason === "error" || assistant.stopReason === "aborted";
				const calls = assistant.content.filter((content): content is ToolCallBlock => content.type === "tool_call");
				let terminate = false;
				if (!terminalFailure && assistant.stopReason !== "deferred" && assistant.stopReason !== "length" && !signal.aborted) {
					const results = await Promise.all(calls.map(async (call) => {
						if (signal.aborted) return undefined;
						emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments, timestamp: timestamp() });
						let result: Awaited<ReturnType<ExecutionDriver["execute"]>>;
						let content: string;
						try {
							result = await this.driver.execute(call, signal);
							content = JSON.stringify({ content: result.message.content, ...(result.details !== undefined ? { details: result.details } : {}) });
						} catch (error) {
							result = { message: { role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: timestamp(), isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
							content = JSON.stringify({ content: result.message.content });
						}
						emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content, isError: result.message.isError ?? false, timestamp: timestamp() });
						return result;
					}));
					terminate = results.length > 0 && results.every((result) => result?.terminate === true);
					for (const result of results) {
						if (!result) continue;
						emit({ type: "message_start", message: result.message, timestamp: timestamp() });
						await append(result.message);
					}
				}
				if (signal.aborted && assistant.stopReason !== "aborted") {
					assistant = { ...assistant, stopReason: "aborted" };
				}
				emit({ type: "turn_end", timestamp: timestamp(), ...(assistant.stopReason ? { stopReason: assistant.stopReason } : {}) });
				if (terminalFailure || signal.aborted || assistant.stopReason === "length") return false;
				if (this.settings.enabled && assistant.stopReason === "stop" && overflow) await this.compactContext("usage", signal, emit);
				if (assistant.stopReason === "deferred") return true;
				const steering = this.steering.shift();
				if (steering) pending.push(steering);
				if ((calls.length > 0 && !terminate) || pending.length) continue;
				const followup = this.followups.shift();
				if (followup) { pending.push(followup); continue; }
				return true;
			}
		} catch (error) {
			if (this.faulted) throw error;
			const message: SessionMessage = {
				role: "assistant", content: [], timestamp: timestamp(),
				stopReason: signal.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			emit({ type: "message_start", timestamp: timestamp(), message });
			await append(message);
			emit({ type: "turn_end", timestamp: timestamp(), stopReason: message.stopReason! });
			return false;
		} finally {
			// Close atomically with the last queue check, before buffered events reach the host.
			this.closeInput();
			emit({ type: "agent_end", timestamp: timestamp() });
		}
	}

	private async persistEntry(entry: SessionEntry): Promise<void> {
		try { await this.storage.append(structuredClone(entry)); }
		catch (error) { this.faulted = true; this.abort(); throw error; }
		this.state.entries.push(entry);
		this.state.leafId = entry.id;
	}

	private userMessage(input: string): SessionMessage {
		return { role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() };
	}
	private syncUsage(messages = projectMessages(this.messages)): void {
		this.usage.setContext({ messages, contextWindow: this.driver.contextWindow, ...(this.driver.contextIdentity !== undefined ? { identity: this.driver.contextIdentity } : {}), ...(this.driver.fixedText !== undefined ? { fixedText: this.driver.fixedText } : {}) });
	}
}
