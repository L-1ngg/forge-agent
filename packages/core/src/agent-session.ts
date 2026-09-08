import type { ConfigurationPatch, ConfigurationReceipt, SessionAssembly, SessionToolset } from "./configuration.ts";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import type { AgentMessage } from "./runtime/types.ts";
import { Agent as RuntimeAgent } from "./runtime/agent.ts";
import { fromSessionMessage, createEventProjection, toSessionMessage } from "./event-projection.ts";
import type { AgentPort, InputAcceptance } from "./agent-port.ts";
import type { ModelPortOptions } from "./pi-port.ts";
import { MemorySessionStorage, messageEntry, projectMessages, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { randomUUID } from "node:crypto";
import { resolveRetryPolicy, waitForRetry, DEFAULT_CONTEXT, generateCompaction, prepareCompaction, type CompactionReason, type CompactionResult, type ContextSettings, buildContext } from "./context/compaction.ts";
import { UsageTracker } from "./usage.ts";

/** Owns durable history and run settlement; the runtime alone owns request messages. */
export class AgentSession implements AgentPort {
	private readonly runtime: RuntimeAgent;
	private readonly projectEvent = createEventProjection();
	private options: ModelPortOptions;
	private toolset: SessionToolset;
	private driver: SessionAssembly["driver"];
	private responseDriver: SessionAssembly["driver"] | undefined;
	private disposed = false;
	private executing = false;
	private revision = 0;
	private configurationQueue: Promise<void> = Promise.resolve();
	private pendingConfigurations: Array<{ assembly: SessionAssembly; revision: number; resolve: (value: Awaited<ConfigurationReceipt["applied"]>) => void }> = [];
	private storage: SessionStorage;
	private state: SessionState = { entries: [], leafId: null };
	private initialized = false;
	private settings: ContextSettings;
	private compactController: AbortController | undefined;
	private runController: AbortController | undefined;
	private recoveryUsed = false;
	private taskFailures = 0;
	private accepting = false;
	private receipts = new Map<AgentMessage, (processed: boolean) => void>();
	private failure: unknown;
	private readonly usage: UsageTracker;
	private running: Promise<void> | undefined;
	private emit: (event: SessionEvent) => void = () => { };

	constructor(assembly: SessionAssembly, private readonly prepareConfiguration: (patch: ConfigurationPatch) => Promise<SessionAssembly>) {
		this.options = assembly.options; this.toolset = assembly.toolset; this.driver = assembly.driver;
		const options = this.options;
		const toolset = this.toolset;
		this.settings = { ...DEFAULT_CONTEXT, ...options.context };
		this.configureContext(options.context ?? {});
		this.storage = new MemorySessionStorage(options.history);
		this.usage = new UsageTracker({ contextWindow: options.contextWindow ?? options.model.contextWindow });
		this.runtime = new RuntimeAgent({
			...(options.steeringMode ? { steeringMode: options.steeringMode } : {}),
			...(options.followUpMode ? { followUpMode: options.followUpMode } : {}),
			initialState: { model: options.model, systemPrompt: options.systemPrompt, thinkingLevel: options.thinkingLevel, tools: toolset?.tools ?? [] },
			beforeToolCall: (context, signal) => this.toolset.beforeToolCall?.(context, signal) ?? Promise.resolve(undefined),
			afterToolCall: (context, signal) => this.toolset.afterToolCall?.(context, signal) ?? Promise.resolve(undefined),
			...(toolset.toolExecution ? { toolExecution: toolset.toolExecution } : {}),
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
			shouldStopAfterResponse: ({ message }) => message.stopReason === "length" || message.stopReason === "deferred",
			prepareNextTurnWithContext: () => { this.applyConfigurations(); return { context: { systemPrompt: this.runtime.state.systemPrompt, tools: this.runtime.state.tools, messages: this.runtime.state.messages.slice() }, model: this.options.model, thinkingLevel: this.options.thinkingLevel }; },
			transformContext: async (messages, signal) => {
				signal?.throwIfAborted(); this.syncUsage();
				if (this.settings.enabled && (this.getUsage().contextTokens ?? 0) > (this.options.contextWindow ?? this.options.model.contextWindow) - this.settings.reserveTokens) await this.compactContext("threshold", signal ?? this.runController!.signal, this.emit);
				signal?.throwIfAborted();
				return this.runtime.state.messages.slice();
			},
			convertToLlm: messages => projectMessages(messages.map(message => toSessionMessage(message)!)).map(message => fromSessionMessage(message, this.options.model)),
			streamFn: (model, context, settings) => {
				settings?.signal?.throwIfAborted();
				this.responseDriver = this.driver;
				return this.options.stream(model, context, { ...settings, maxRetries: 0, ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}) });
			},
		});
		this.runtime.subscribe(async event => {
			// Agent reduces state before awaited listeners, and reports listener failures as
			// run failures. A failed store must never be re-entered by that error reporting.
			if (this.failure !== undefined) throw this.failure;
			if (event.type === "message_start" && event.message.role === "user") {
				this.runController?.signal.throwIfAborted();
				this.receipts.get(event.message)?.(true); this.receipts.delete(event.message);
			}
			if (event.type === "message_end") {
				if (event.message.role === "user") this.recoveryUsed = false;
				const message = toSessionMessage(event.message);
				if (message?.role === "assistant" && !["error", "aborted", "length"].includes(message.stopReason ?? "")) { this.taskFailures = 0; this.recoveryUsed = false; }
				if (message && this.settings.enabled && this.recoverableLength(message)) { message.contextExcluded = true; Object.assign(event.message, { contextExcluded: true }); }
				if (message) {
					const entry = messageEntry(message, this.state.leafId);
					this.receipts.get(event.message)?.(true); this.receipts.delete(event.message);
					await this.persistEntry(entry);
					this.syncUsage();
					if (message.usage) this.usage.recordUsage(message.usage);
				}
			}
			if (event.type === "turn_end") this.applyConfigurations();
			const projected = this.projectEvent(event);
			if (event.type === "agent_start" || event.type === "agent_end") return;
			if (projected) this.emit(projected);
		});
	}
	async setStorage(storage: SessionStorage): Promise<void> {
		this.assertHealthy();
		if (this.running) throw new Error("Cannot replace storage during execution");
		if (this.initialized && storage === this.storage) return;
		const state = await storage.load();
		this.state = structuredClone(state); this.storage = storage; this.initialized = true;
		this.runtime.state.messages = buildContext(state).map(message => fromSessionMessage(message, this.options.model));
		this.usage.invalidate(); this.syncUsage();
	}
	runTurn(input: string): AsyncIterable<SessionEvent> { return this.run(input); }
	continue(): AsyncIterable<SessionEvent> { return this.run(); }
	private async *run(input?: string): AsyncIterable<SessionEvent> {
		this.assertHealthy();
		if (this.running) throw new Error("Agent is already processing a turn");
		if (!this.initialized) await this.setStorage(this.storage);
		const events: SessionEvent[] = [];
		let wake: (() => void) | undefined;
		let done = false;
		let failure: unknown;
		this.emit = event => { events.push(structuredClone(event)); wake?.(); };
		this.usage.beginTurn(); this.accepting = true;
		this.runController = new AbortController();
		const running = this.runSession(input, this.runController.signal)
			.catch(error => { failure = error; })
			.finally(() => { done = true; wake?.(); });
		this.running = running;
		try {
			while (!done || events.length) {
				const event = events.shift();
				if (event) yield event;
				else await new Promise<void>(resolve => { wake = resolve; });
			}
		} finally {
			if (!done) this.abort();
			await running;
			this.closeInput(); this.toolset?.clear();
			this.emit = () => { };
			this.running = undefined; this.runController = undefined;
			this.syncUsage(); this.usage.endTurn();
			if (failure !== undefined) throw failure;
		}
	}
	steer(input: string): InputAcceptance { return this.enqueue(input, "steer"); }
	followUp(input: string): InputAcceptance { return this.enqueue(input, "followUp"); }
	private enqueue(input: string, mode: "steer" | "followUp"): InputAcceptance {
		this.assertHealthy();
		if (!this.accepting) return { accepted: false };
		const message: AgentMessage = { role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() };
		const processed = new Promise<boolean>(resolve => { this.receipts.set(message, resolve); });
		this.runtime[mode](message);
		return { accepted: true, processed };
	}
	private closeInput(): void {
		this.accepting = false; this.runtime.clearAllQueues();
		for (const resolve of this.receipts.values()) resolve(false);
		this.receipts.clear();
	}
	abort(): void { this.runController?.abort(); this.compactController?.abort(); this.closeInput(); this.runtime.abort(); this.options.requestBus?.abort(); }
	getUsage() { return this.usage.snapshot(); }
	private syncUsage(): void {
		this.usage.setContext({ messages: projectMessages(this.runtime.state.messages.map(message => toSessionMessage(message)!)), contextWindow: this.options.contextWindow ?? this.options.model.contextWindow, identity: JSON.stringify([this.options.model, this.options.systemPrompt, this.options.thinkingLevel, this.options.tools]), fixedText: this.options.systemPrompt + (this.runtime.state.tools.length ? JSON.stringify(this.runtime.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))) : "") });
	}
	configureContext(settings: Partial<ContextSettings>): void {
		if (this.running || this.compactController) throw new Error("Cannot configure context during execution");
		const next = { ...this.settings, ...settings };
		if (!Number.isInteger(next.reserveTokens) || next.reserveTokens < 1 || !Number.isInteger(next.keepRecentTokens) || next.keepRecentTokens < 1 || typeof next.enabled !== "boolean" || !["inherit", "off"].includes(next.summaryReasoning)) throw new Error("Invalid context settings");
		this.settings = next;
	}

	async compact(instructions?: string, emit: (event: SessionEvent) => void = () => { }, signal?: AbortSignal): Promise<CompactionResult> {
		this.assertHealthy();
		if (this.running || this.compactController) throw new Error("Wait for active execution before compaction");
		if (!this.initialized) await this.setStorage(this.storage);
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		this.compactController = controller;
		try { return await this.compactContext("manual", controller.signal, emit, instructions); }
		finally { signal?.removeEventListener("abort", abort); this.compactController = undefined; this.applyConfigurations(); }
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
			this.runtime.state.messages = buildContext(this.state).map(message => fromSessionMessage(message, this.options.model));
			this.usage.invalidate(); this.syncUsage();
			const afterTokens = this.getUsage().contextTokens ?? 0;
			event("end", { afterTokens, ...(result.usage ? { usage: result.usage } : {}) });
			return { status: "complete", operationId, beforeTokens, afterTokens };
		} catch (error) {
			if (this.failure !== undefined) throw error;
			const message = error instanceof Error ? error.message : String(error);
			event("error", { error: message });
			return { status: "error", operationId, beforeTokens, error: message };
		}
	}

	private async persistEntry(entry: SessionEntry): Promise<void> {
		try { await this.storage.append(structuredClone(entry)); }
		catch (error) { this.failure = error; this.abort(); throw error; }
		this.state.entries.push(entry); this.state.leafId = entry.id;
	}

	private recoverableLength(message: SessionMessage): boolean {
		const driver = this.responseDriver ?? this.driver;
		return message.stopReason === "length" && (driver.maxTokens ?? 0) > 0 && message.usage !== undefined && message.usage.output < driver.maxTokens!;
	}
	private async runSession(input: string | undefined, signal: AbortSignal): Promise<void> {
		this.executing = true;
		this.emit({ type: "agent_start", timestamp: Date.now() });
		const retry = resolveRetryPolicy(this.options.retry);
		this.taskFailures = 0;
		let retried = false;
		let lastRetryAttempt = 0;
		try {
			let first = true;
			while (!signal.aborted) {
				this.applyConfigurations();
				if (first && input !== undefined) await this.runtime.prompt(input);
				else await this.runtime.continue();
				first = false;
				if (this.failure !== undefined) throw this.failure;
				if (signal.aborted) return;
				const last = this.runtime.state.messages.at(-1);
				const message = last ? toSessionMessage(last) : undefined;
				if (!message || signal.aborted) return;
				const responseDriver = this.responseDriver ?? this.driver;
				const overflow = responseDriver.isOverflow(message);
				const length = this.recoverableLength(message);
				if (this.settings.enabled && ((message.stopReason === "error" && overflow) || length)) {
					if (this.recoveryUsed) return;
					this.recoveryUsed = true;
					const reason = length ? "length" : "overflow";
					this.emit({ type: "recovery", reason, operationId: randomUUID(), attempt: 1, timestamp: Date.now() });
					const result = await this.compactContext(reason, signal, this.emit);
					if (result.status !== "complete" || signal.aborted) return;
					this.runtime.state.messages = projectMessages(this.runtime.state.messages.map(message => toSessionMessage(message)!)).map(message => fromSessionMessage(message, this.options.model));
					continue;
				}
				if (message.stopReason === "error" && !overflow && retry.enabled && responseDriver.isRetryable?.(message) && this.taskFailures < retry.maxRetries) {
					const attempt = ++this.taskFailures; retried = true; lastRetryAttempt = attempt;
					const delayMs = retry.baseDelayMs * 2 ** (attempt - 1);
					this.emit({ type: "retry", phase: "scheduled", attempt, delayMs, ...(message.errorMessage ? { error: message.errorMessage } : {}), timestamp: Date.now() });
					try { await (this.driver.wait ?? waitForRetry)(delayMs, signal); } catch (error) { if (signal.aborted) return; throw error; }
					signal.throwIfAborted();
					this.runtime.state.messages = projectMessages(this.runtime.state.messages.map(message => toSessionMessage(message)!)).map(message => fromSessionMessage(message, this.options.model));
					this.usage.invalidate(); this.syncUsage();
					this.emit({ type: "retry", phase: "attempt", attempt, timestamp: Date.now() });
					continue;
				}
				if (message.stopReason !== "error" && message.stopReason !== "length" && message.stopReason !== "aborted") this.recoveryUsed = false;
				if (this.settings.enabled && message.stopReason === "stop" && overflow) await this.compactContext("usage", signal, this.emit);
				return;
			}
		} finally {
			this.closeInput(); this.executing = false; this.applyConfigurations();
			const last = this.runtime.state.messages.at(-1);
			const reason = last?.role === "assistant" ? last.stopReason : undefined;
			const outcome = this.failure !== undefined ? "error" : signal.aborted ? "aborted" : reason === "error" || reason === "aborted" || reason === "length" || reason === "deferred" ? reason : "success";
			if (retried) this.emit({ type: "retry", phase: "end", attempt: lastRetryAttempt, outcome: outcome === "success" ? "success" : outcome === "aborted" ? "aborted" : "error", timestamp: Date.now() });
			this.emit({ type: "agent_end", outcome, timestamp: Date.now() });
		}
	}

	updateConfiguration(patch: ConfigurationPatch): Promise<ConfigurationReceipt> {
		this.assertHealthy();
		// Snapshot schemas now, before asynchronous model/auth resolution yields to hosts.
		const captured = { ...patch, ...(patch.tools ? { tools: patch.tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : {}) };
		const operation = this.configurationQueue.then(async () => {
			this.assertHealthy();
			const assembly = await this.prepareConfiguration(captured);
			this.assertHealthy();
			const revision = ++this.revision;
			const applied = new Promise<Awaited<ConfigurationReceipt["applied"]>>(resolve => { this.pendingConfigurations.push({ assembly, revision, resolve }); });
			this.emit({ type: "configuration", phase: "accepted", revision, timestamp: Date.now() });
			if (!this.executing && !this.compactController) this.applyConfigurations();
			return { accepted: true as const, revision, applied };
		});
		this.configurationQueue = operation.then(() => { }, () => { });
		return operation;
	}
	private applyConfigurations(): void {
		for (const pending of this.pendingConfigurations.splice(0)) {
			if (this.disposed || this.failure !== undefined) { pending.resolve({ status: "canceled", revision: pending.revision }); continue; }
			this.toolset.clear();
			this.options = pending.assembly.options; this.toolset = pending.assembly.toolset; this.driver = pending.assembly.driver;
			this.runtime.state.model = this.options.model; this.runtime.state.systemPrompt = this.options.systemPrompt;
			this.runtime.state.thinkingLevel = this.options.thinkingLevel; this.runtime.state.tools = this.toolset.tools;
			this.usage.invalidate(); this.syncUsage();
			pending.resolve({ status: "applied", revision: pending.revision });
			this.emit({ type: "configuration", phase: "applied", revision: pending.revision, timestamp: Date.now() });
		}
	}
	async dispose(): Promise<void> { this.disposed = true; this.abort(); this.applyConfigurations(); await this.running; await this.configurationQueue; }
	private assertHealthy(): void { if (this.disposed) throw new Error("Agent has been disposed"); if (this.failure !== undefined) throw new Error("Agent is faulted; recreate it from storage", { cause: this.failure }); }
}
