import type { HarnessTool } from "@forge-agent/tools";
import { type SessionEvent, type SessionMessage, type ResponseEnvelope, type TurnResult } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import type { Agent, AgentTurn, InputAcceptance } from "./agent.ts";
import type { ConfigurationPatch, ConfigurationReceipt, SessionAssembly, SessionConfiguration } from "./configuration.ts";
import { snapshotConfiguration } from "./session-configuration.ts";
import { RequestBus } from "./request-bus.ts";
import { transformMessages } from "./context/transform.ts";
import { checkRequestBudget, isolateRequest, requestFixedText, REQUEST_MARGIN, type RequestBudget } from "./context/request-budget.ts";
import { TurnPolicy } from "./turn-policy.ts";
import { explicitSkillBody, type PreparedSkills } from "./skills/source.ts";
import { calculateContextUsage, UsageTracker } from "./usage.ts";
import { emptySkills, SkillError, type SkillsSnapshot, type AgentInput } from "./skills/types.ts";
import { CompactionCoordinator } from "./context/coordinator.ts";
import { decorateToolEvent, type CommandPresentation } from "./event-projection.ts";
import type { BlockEnvelope } from "@forge-agent/protocol";
import { validateSessionTools } from "./session-tools.ts";
import { contextReader } from "./context/read-context.ts";
import { contextSearcher } from "./context/search-context.ts";
import { messageEntry, ownSessionState, prepareSessionAppend, projectMessages, selectedBranch, sessionMessages, type MessageEntry, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { buildContext, resolveRetryPolicy, waitForRetry, DEFAULT_CONTEXT, type CompactionResult, type ContextSettings } from "./context/compaction.ts";
import { compactionInputBudget, type CompactionBudget } from "./context/compact.ts";
import { checkpointProjectionBudget } from "./context/checkpoint.ts";
import { SessionInvocation } from "./session-invocation.ts";
import { runNativeExecution, type NativeRequest, type ResponseBatch } from "./native-execution.ts";

/** The sole owner of input, durable history, configuration and invocation settlement. */
export class AgentSession implements Agent {
	readonly requests;
	private skills: SkillsSnapshot;
	private skillSources: PreparedSkills;
	private readonly compaction: CompactionCoordinator;
	private options: SessionConfiguration;
	private tools: Array<HarnessTool<object, unknown>>;
	private driver: SessionAssembly["driver"];
	private preparationFailed = false;
	private requestProjection: { messages: SessionMessage[]; tokens?: number; contextWindow: number; } | undefined;
	private responseDriver: SessionAssembly["driver"] | undefined;
	private lastResponse: SessionMessage | undefined;
	private disposed = false;
	private disposing: Promise<void> | undefined;
	private executing = false;
	private inChat = false;
	private revision = 0;
	private appliedRevision = 0;
	private readonly configurationController = new AbortController();
	private configurationQueue: Promise<void> = Promise.resolve();
	private pendingConfigurations: Array<{ assembly: SessionAssembly; revision: number; runBound: boolean; resolve: (value: Awaited<ConfigurationReceipt["applied"]>) => void; }> = [];
	private state: SessionState;
	private settings: ContextSettings;
	private compactController: AbortController | undefined;
	private compacting: Promise<CompactionResult> | undefined;
	private readonly preparedSkills = new WeakSet<SessionMessage>();
	private readonly explicitSkillNames = new Set<string>();
	private readonly stagedMcp = new Map<SessionMessage, string[]>();
	private skillInputs = new Map<SessionMessage, { invocation: Exclude<AgentInput, string>; inputId: string; }>();
	private failure: unknown;
	private readonly usage: UsageTracker;
	private active: SessionInvocation | undefined;
	private running: Promise<void> | undefined;
	private emit: (event: SessionEvent) => void = () => { };

	constructor(assembly: SessionAssembly, private readonly storage: SessionStorage, private readonly bus: RequestBus, state: SessionState,
		private readonly prepareConfiguration: (patch: ConfigurationPatch, refresh?: boolean, signal?: AbortSignal) => Promise<SessionAssembly>) {
		this.requests = bus.requests();
		this.state = ownSessionState(state);
		this.skills = assembly.skills ?? emptySkills();
		this.skillSources = assembly.skillSources ?? { snapshot: emptySkills() };
		this.options = assembly.options; this.driver = assembly.driver;
		const options = this.options;
		this.settings = { ...DEFAULT_CONTEXT, ...options.context };
		this.tools = this.prepareTools();
		this.usage = new UsageTracker({ contextWindow: options.contextWindow ?? options.model.contextWindow });
		this.compaction = new CompactionCoordinator({
			messages: budget => this.messages(budget), tools: () => this.tools, usage: this.usage,
			configuration: () => ({ options: this.options, driver: this.summaryDriver(), settings: this.settings }),
			history: () => this.state, persist: entry => this.persistEntry(entry), isFaulted: () => this.failure !== undefined,
		});
		this.configureContext(options.context ?? {});
	}
	private messages(budget = this.compaction.budget()): SessionMessage[] { return buildContext(this.state, checkpointProjectionBudget(compactionInputBudget(budget, this.settings.reserveTokens) - Math.ceil(budget.fixedText.length / 4))); }
	runTurn(input: AgentInput): AgentTurn { return this.startTurn(input); }
	continue(): AgentTurn { return this.startTurn(); }
	waitForIdle(): Promise<void> { return this.compacting?.then(() => { }) ?? this.active?.settled ?? Promise.resolve(); }
	private startTurn(input?: AgentInput): AgentTurn {
		this.assertHealthy();
		if (this.compacting) throw new Error("Agent is compacting");
		const id = Symbol("invocation"), inputId = input !== undefined && typeof input !== "string" ? randomUUID() : undefined;
		if (input !== undefined && typeof input !== "string") input = structuredClone(input);
		let started = false;
		let resolveResult!: (result: TurnResult) => void;
		const result = new Promise<TurnResult>(resolve => { resolveResult = resolve; });
		return {
			id, result, ...(inputId ? { inputId } : {}), [Symbol.asyncIterator]: () => {
				this.assertHealthy();
				if (this.compacting) throw new Error("Agent is compacting");
				if (started) throw new Error("A turn can only be consumed once");
				if (this.active) throw new Error("Agent is already processing a turn");
				started = true;
				const active = new SessionInvocation(id, this.options.shouldStopAfterTurn ? new TurnPolicy(this.options.shouldStopAfterTurn) : undefined, resolveResult, () => { if (this.active === active) this.active = undefined; });
				this.active = active;
				return active.consume(this.events(active, input, inputId)[Symbol.asyncIterator](), () => this.abort());
			}
		};
	}
	private async *events(active: SessionInvocation, input?: AgentInput, inputId?: string): AsyncIterable<SessionEvent> {
		const events: SessionEvent[] = [], commands = new Map<string, CommandPresentation>(), edits = new Map<string, BlockEnvelope<"edit">>();
		let wake: (() => void) | undefined, done = false, failure: unknown;
		this.emit = event => { events.push(structuredClone(decorateToolEvent(event, commands, edits))); wake?.(); };
		this.usage.beginTurn();
		this.preparationFailed = false; this.requestProjection = undefined; this.lastResponse = undefined;
		this.explicitSkillNames.clear();
		const running = this.runSession(input, active.controller.signal, inputId).then(result => { active.outcome = result; }, error => { failure = error; active.outcome = { status: "error" }; }).finally(() => { done = true; wake?.(); });
		this.running = running;
		try {
			while (!done || events.length) {
				const event = events.shift(); if (event) yield event;
				else await new Promise<void>(resolve => { wake = resolve; });
			}
		} finally {
			if (!done) this.abort();
			await running; this.closeInput();
			this.emit = () => { }; this.running = undefined; this.requestProjection = undefined;
			this.compaction.syncUsage(); this.usage.endTurn();
			if (failure !== undefined) throw failure;
		}
	}
	steer(input: AgentInput, id: symbol): InputAcceptance { return this.enqueue(input, "steer", id); }
	followUp(input: AgentInput, id: symbol): InputAcceptance { return this.enqueue(input, "followUp", id); }
	private enqueue(input: AgentInput, mode: "steer" | "followUp", id: symbol): InputAcceptance {
		this.assertHealthy();
		const active = this.active;
		if (!active || active.id !== id || active.canceled || !active.begun) return { accepted: false };
		const inputId = typeof input === "string" ? undefined : randomUUID(), message = this.inputMessage(input, inputId);
		const receipt = active.enqueue(message, mode, id);
		return { ...receipt, ...(receipt.accepted && inputId ? { inputId } : {}) };
	}
	private async consumeInput(message: SessionMessage, signal: AbortSignal): Promise<void> {
		await this.prepareInputMessage(message, signal); signal.throwIfAborted();
		this.emit({ type: "message_start", message: structuredClone(message), timestamp: Date.now() });
		if (!this.preparedSkills.has(message)) { this.active?.acknowledge(message, true); }
		this.stagedMcp.delete(message);
		await this.persistMessage(message);
		if (this.preparedSkills.has(message)) { this.active?.acknowledge(message, true); this.preparedSkills.delete(message); }
		this.active?.resetRecovery();
		this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
	}
	private inputMessage(input: AgentInput, inputId?: string): SessionMessage {
		const message: SessionMessage = { role: "user", content: [{ type: "text", text: typeof input === "string" ? input : "" }], timestamp: Date.now() };
		if (typeof input !== "string") this.skillInputs.set(message, { invocation: structuredClone(input), inputId: inputId ?? randomUUID() });
		return message;
	}
	private async prepareInputMessage(message: SessionMessage, signal?: AbortSignal): Promise<void> {
		const selected = this.skillInputs.get(message);
		try {
			signal?.throwIfAborted(); this.active?.controller.signal.throwIfAborted();
			if (selected) {
				const { invocation, inputId } = selected;
				if (invocation.kind !== "skill") {
					const manager = this.options.mcpManager; if (!manager) throw new Error("MCP is unavailable");
					let context: import("@forge-agent/protocol").McpInputContext;
					if (invocation.kind === "mcp_prompt") context = await manager.getPrompt(invocation.serverId, invocation.name, invocation.arguments, signal ? { signal } : {});
					else { const result = await manager.readResource(invocation.serverId, invocation.uri, signal ? { signal } : {}); context = { kind: "mcp_resource", serverId: invocation.serverId, name: invocation.uri, catalogRevision: result.catalogRevision, fetchedAt: result.fetchedAt, messages: [{ role: "user", content: result.content }], artifacts: result.artifacts }; }
					this.stagedMcp.set(message, context.artifacts.map(ref => ref.id));
					context.task = invocation.task;
					if (!this.options.model.input.includes("image")) for (const item of context.messages) item.content = item.content.map(block => block.type === "image" ? { type: "text", text: "This model does not support image input; original bytes are retained in MCP attachments." } : block);
					Object.assign(message, { inputContext: context });
					message.content = [{ type: "text", text: `MCP ${context.serverId}/${context.name}\n${context.messages.map(item => `[${item.role}] ` + item.content.filter(block => block.type === "text").map(block => block.text).join("\n")).join("\n")}\nUser task:\n${invocation.task}` }];
				} else {
					if (typeof invocation.task !== "string") throw new SkillError("invalid-skill", "Invalid Skill invocation");
					if (!this.skillSources.all) throw new SkillError("skills-disabled", "Skills are disabled");
					if (!this.skills.entries.some(entry => entry.status === "available" && entry.name === invocation.name)) throw new SkillError("unknown-skill", `Unknown skill: ${invocation.name}`);
					const body = explicitSkillBody(await this.skillSources.all.load(invocation.name));
					message.content = [{ type: "text", text: `Skill instructions (${invocation.name}):\n${body}\n\nUser task:\n${invocation.task}` }];
					this.explicitSkillNames.add(invocation.name);
				}
			}
			signal?.throwIfAborted(); this.active?.controller.signal.throwIfAborted();
			if (this.skills.enabled || selected?.invocation.kind === "mcp_prompt" || selected?.invocation.kind === "mcp_resource") {
				const budget = this.compaction.budget();
				const size = calculateContextUsage({ fixedText: budget.fixedText, messages: projectMessages([message]) }).contextTokens ?? 0;
				if (size > compactionInputBudget(budget, this.settings.reserveTokens)) throw new SkillError("too-large", "Skills and input exceed context budget; reduce Skill sources or split instructions into references.");
			}
			if (selected) this.preparedSkills.add(message);
		} catch (error) {
			if (selected) {
				const code = signal?.aborted || this.active?.controller.signal.aborted ? "canceled" : error instanceof SkillError ? error.code : "read-failed";
				if (selected.invocation.kind === "skill") this.emit({ type: "skill_input", phase: "rejected", inputId: selected.inputId, name: selected.invocation.name, code, message: String(error), timestamp: Date.now() });
				this.active?.acknowledge(message, false);
			}
			throw error;
		} finally { this.skillInputs.delete(message); }
	}

	private closeInput(): void { this.active?.closeInput(); this.skillInputs.clear(); }
	abort(): void { this.active?.cancel(); this.compactController?.abort(); this.closeInput(); this.bus.abort(); }
	getUsage() {
		if (this.disposed) return undefined;
		const snapshot = this.usage.snapshot(), request = this.requestProjection;
		return request?.tokens === undefined ? snapshot : { ...snapshot, contextTokens: request.tokens, contextWindow: request.contextWindow, contextEstimated: true };
	}
	private requestBudget(budget: CompactionBudget): RequestBudget {
		return {
			contextWindow: budget.window, inputBudget: compactionInputBudget(budget, this.settings.reserveTokens), maxInputTokens: budget.window - budget.output - REQUEST_MARGIN,
			fixedTokens: Math.ceil(budget.fixedText.length / 4), maxTokens: this.compaction.taskMaxTokens(), effectiveOutputTokens: budget.output
		};
	}
	private async prepareRequestContext(signal: AbortSignal, compactionBudget: CompactionBudget): Promise<SessionMessage[]> {
		try {
			signal.throwIfAborted(); this.requestProjection = undefined;
			const history = () => projectMessages(this.messages(compactionBudget));
			this.compaction.syncUsage(compactionBudget);
			const budget = this.requestBudget(compactionBudget);
			const contextTokens = calculateContextUsage({ messages: history(), fixedText: compactionBudget.fixedText }).contextTokens ?? 0;
			if (this.settings.enabled && contextTokens > budget.inputBudget) {
				const result = await this.compaction.run("threshold", signal, this.emit, undefined, compactionBudget);
				if (result.status !== "complete") throw new Error(result.error ?? "Context cannot fit request budget");
			}
			signal.throwIfAborted();
			let messages = history();
			if (this.options.transformContext) {
				this.usage.invalidate();
				messages = await transformMessages(this.options.transformContext, { messages, model: this.options.model, configurationRevision: this.appliedRevision, budget }, signal);
			}
			signal.throwIfAborted();
			this.requestProjection = { messages, contextWindow: budget.contextWindow };
			signal.throwIfAborted();
			return messages;
		} catch (error) {
			this.requestProjection = undefined;
			signal.throwIfAborted();
			this.preparationFailed = true;
			throw error;
		}
	}
	private prepareTools(): Array<HarnessTool<object, unknown>> {
		validateSessionTools(this.options);
		return [...this.options.tools ?? [], contextReader(() => this.state), contextSearcher(() => this.state)];
	}
	configureContext(settings: Partial<ContextSettings>): void {
		this.assertHealthy();
		if (this.running || this.compactController) throw new Error("Cannot configure context during execution");
		const next = { ...this.settings, ...settings };
		if ("strategy" in next || !Number.isInteger(next.reserveTokens) || next.reserveTokens < 1 || !Number.isInteger(next.keepRecentTokens) || next.keepRecentTokens < 1 || typeof next.enabled !== "boolean" || !["inherit", "off"].includes(next.summaryReasoning)) throw new Error("Invalid context settings");
		validateSessionTools(this.options); this.settings = next; this.tools = this.prepareTools(); this.compaction.rebuild();
	}
	compact(instructions?: string, emit: (event: SessionEvent) => void = () => { }): Promise<CompactionResult> {
		this.assertHealthy(); if (this.compacting) throw new Error("Agent is compacting");
		const active = this.active; this.abort();
		const controller = new AbortController(); this.compactController = controller;
		const running = (async () => {
			try {
				await active?.iterator.return?.(); active?.finish();
				if (this.disposed) throw new Error("Agent has been disposed");
				return await this.compaction.run("manual", controller.signal, emit, instructions);
			} catch (error) { active?.finish("error"); throw error; }
			finally { this.compacting = undefined; this.compactController = undefined; this.applyConfigurations(); }
		})();
		this.compacting = running; return running;
	}
	private async persistEntry(entry: SessionEntry): Promise<void> {
		let publish!: () => void;
		try { publish = prepareSessionAppend(this.state, entry); await this.storage.append(structuredClone(entry)); }
		catch (error) { this.failure = error; this.abort(); throw error; }
		publish();
	}
	private async persistMessage(message: SessionMessage): Promise<void> {
		await this.persistEntry(messageEntry(message, this.state.leafId));
		this.requestProjection = undefined; this.compaction.syncUsage();
		if (message.usage) this.usage.recordUsage(message.usage, !this.options.transformContext);
	}
	private async commitBatch(batch: ResponseBatch): Promise<void> {
		const { message, toolResults, options, revision } = batch;
		if (batch.preparationFailed) this.preparationFailed = true;
		this.lastResponse = message;
		if (!["error", "aborted", "length"].includes(message.stopReason ?? "")) this.active?.resetFailures();
		if (this.settings.enabled && this.recoverableLength(message)) message.contextExcluded = true;
		await this.persistMessage(message);
		this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
		for (const result of toolResults) {
			this.emit({ type: "message_start", message: structuredClone(result), timestamp: Date.now() });
			await this.persistMessage(result);
			this.emit({ type: "message_end", message: structuredClone(result), timestamp: Date.now() });
		}
		if (!batch.turnComplete) return;
		this.emit({ type: "turn_end", ...(message.stopReason ? { stopReason: message.stopReason } : {}), timestamp: Date.now() });
		this.applyConfigurations();
		if (this.active?.policy && !["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "")) {
			await this.active.policy.evaluate({ message, toolResults, model: structuredClone(options.model), configurationRevision: revision }, this.active.controller.signal);
		}
	}
	private async prepareNativeRequest(initial: boolean, signal: AbortSignal): Promise<NativeRequest> {
		signal.throwIfAborted(); this.lastResponse = undefined;
		if (!initial) {
			this.applyConfigurations();
			for (const message of this.active!.drain("steer", this.options.steeringMode)) await this.consumeInput(message, signal);
		}
		this.responseDriver = this.driver;
		return {
			options: { ...this.options }, revision: this.appliedRevision, tools: this.tools,
			settings: { signal, maxTokens: this.compaction.taskMaxTokens(), cacheHints: this.options.cacheHints !== false, ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}), ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), ...(this.options.thinkingLevel !== "off" ? { reasoning: this.options.thinkingLevel } : {}) },
		};
	}
	private async projectNativeRequest(systemPrompt: string, tools: HarnessTool<object, unknown>[], signal: AbortSignal) {
		const budget = this.compaction.budget(requestFixedText({ systemPrompt, tools }));
		const projection = await this.prepareRequestContext(signal, budget);
		const request = isolateRequest({ messages: projectMessages(projection), systemPrompt, tools });
		try {
			const tokens = checkRequestBudget(request, this.requestBudget(budget), this.appliedRevision);
			if (this.requestProjection) this.requestProjection.tokens = tokens;
		} catch (error) { this.preparationFailed = true; throw error; }
		return { messages: request.messages, history: projectMessages(sessionMessages(this.state)) };
	}
	private async runChat(signal: AbortSignal): Promise<void> {
		this.inChat = true;
		const history = () => ({
			messages: sessionMessages(this.state),
			entries: selectedBranch(this.state).filter((entry): entry is MessageEntry => entry.type === "message"),
		});
		try {
			await runNativeExecution({
				prepareRequest: initial => this.prepareNativeRequest(initial, signal),
				projectRequest: (systemPrompt, tools) => this.projectNativeRequest(systemPrompt, tools, signal),
				commit: batch => this.commitBatch(batch), history, fault: () => this.failure,
				release: () => { this.inChat = false; this.applyConfigurations(); return { options: this.options, revision: this.appliedRevision }; },
			}, {
				options: this.options, revision: this.appliedRevision, skills: this.skillSources, explicitSkillNames: this.explicitSkillNames,
				history: history().entries, messages: projectMessages(this.messages()), bus: this.bus, policy: this.active?.policy, signal,
				emit: event => this.emit(event),
			});
		} finally { this.inChat = false; this.applyConfigurations(); }
	}
	private async recordFailure(error: unknown, signal: AbortSignal): Promise<void> {
		const message: SessionMessage = { role: "assistant", content: [], timestamp: Date.now(), provider: this.options.model.provider, model: this.options.model.id, api: this.options.model.api, stopReason: signal.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error) };
		this.lastResponse = message;
		this.emit({ type: "message_start", message, timestamp: Date.now() });
		await this.persistMessage(message);
		this.emit({ type: "message_end", message, timestamp: Date.now() });
		this.emit({ type: "turn_end", stopReason: message.stopReason!, timestamp: Date.now() });
	}
	private summaryDriver(): SessionAssembly["driver"] {
		const driver = this.driver, policy = this.active?.policy;
		if (!policy || !driver.summarize) return driver;
		const summarize = driver.summarize.bind(driver);
		return {
			...driver, summarize: async (request, signal) => {
				const settle = policy.beginRequest();
				try { const response = await summarize(request, signal); settle(response.usage); return response; }
				finally { settle(); }
			}
		};
	}

	private recoverableLength(message: SessionMessage): boolean {
		const driver = this.responseDriver ?? this.driver;
		return message.stopReason === "length" && (driver.maxTokens ?? 0) > 0 && message.usage !== undefined && message.usage.output < driver.maxTokens!;
	}

	private async runSession(input: AgentInput | undefined, signal: AbortSignal, inputId?: string): Promise<TurnResult> {
		this.executing = true; this.emit({ type: "agent_start", timestamp: Date.now() });
		const retry = resolveRetryPolicy(this.options.retry);
		this.active!.resetFailures();
		let retried = false, lastRetryAttempt = 0, outcome: TurnResult = { status: "error" };
		try {
			this.applyConfigurations();
			if (input !== undefined) await this.consumeInput(this.inputMessage(input, inputId), signal);
			else if (!projectMessages(this.messages()).length) throw new Error("Cannot continue: no messages in context");
			while (!signal.aborted) {
				await this.runChat(signal);
				if (signal.aborted || this.preparationFailed || this.active?.policy?.stopped || this.active?.policy?.failed) break;
				const message = this.lastResponse;
				if (!message) break;
				const responseDriver = this.responseDriver ?? this.driver;
				const overflow = responseDriver.isOverflow(message), length = this.recoverableLength(message);
				if (this.settings.enabled && ((message.stopReason === "error" && overflow) || length)) {
					if (!this.active!.claimRecovery()) break;
					const reason = length ? "length" : "overflow";
					this.emit({ type: "recovery", reason, operationId: randomUUID(), attempt: 1, timestamp: Date.now() });
					const result = await this.compaction.run(reason, signal, this.emit);
					if (result.status !== "complete" || signal.aborted) break;
					continue;
				}
				const attempt = message.stopReason === "error" && !overflow && retry.enabled && responseDriver.isRetryable?.(message) ? this.active!.nextRetry(retry.maxRetries) : undefined;
				if (attempt !== undefined) { retried = true; lastRetryAttempt = attempt;
					const delayMs = retry.baseDelayMs * 2 ** (attempt - 1);
					this.emit({ type: "retry", phase: "scheduled", attempt, delayMs, ...(message.errorMessage ? { error: message.errorMessage } : {}), timestamp: Date.now() });
					await (this.driver.wait ?? waitForRetry)(delayMs, signal); signal.throwIfAborted();
					this.usage.invalidate(); this.compaction.syncUsage();
					this.emit({ type: "retry", phase: "attempt", attempt, timestamp: Date.now() });
					this.applyConfigurations();
					continue;
				}
				if (["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "")) break;
				const steering = this.active!.drain("steer", this.options.steeringMode);
				const inputs = steering.length ? steering : this.active!.drain("followUp", this.options.followUpMode);
				if (inputs.length) { this.applyConfigurations(); for (const next of inputs) await this.consumeInput(next, signal); continue; }
				if (this.settings.enabled && message.stopReason === "stop" && overflow) await this.compaction.run("usage", signal, this.emit);
				break;
			}
		} catch (error) {
			if (this.failure !== undefined) throw this.failure;
			if (!signal.aborted) { this.preparationFailed = true; await this.recordFailure(error, signal); }
		} finally {
			this.closeInput();
			for (const [message, ids] of this.stagedMcp) { this.stagedMcp.delete(message); await Promise.all(ids.map(id => this.options.mcpManager?.artifacts.delete?.(id))); }
			this.executing = false; this.applyConfigurations();
			const reason = this.lastResponse?.stopReason;
			outcome = this.active!.result(reason, this.failure !== undefined || this.preparationFailed && !signal.aborted);
			const status = outcome.status;
			if (retried) this.emit({ type: "retry", phase: "end", attempt: lastRetryAttempt, outcome: status === "success" ? "success" : status === "aborted" ? "aborted" : "error", timestamp: Date.now() });
			this.emit({ type: "agent_end", outcome: status, ...(outcome.terminationReason ? { terminationReason: outcome.terminationReason } : {}), timestamp: Date.now() });
		}
		return outcome;
	}
	get mcp() { return this.options.mcpManager!; }
	getSkills(): SkillsSnapshot { return structuredClone(this.skills); }
	refreshSkills(): Promise<ConfigurationReceipt> { return this.updateConfiguration({}, true); }
	updateConfiguration(patch: ConfigurationPatch, refresh = false): Promise<ConfigurationReceipt> {
		this.assertHealthy();
		if (patch.mcp && Object.keys(patch.mcp).some(key => !["enabled", "servers"].includes(key))) return Promise.reject(new TypeError("MCP stores and interaction are configured at creation"));
		if ("streamFn" in patch) return Promise.reject(new TypeError("streamFn was removed; use adapter"));
		if ("transformContext" in patch) return Promise.reject(new TypeError("transformContext is configured at creation"));
		if ("shouldStopAfterTurn" in patch) return Promise.reject(new TypeError("shouldStopAfterTurn is configured at creation"));
		if ("otel" in patch) return Promise.reject(new TypeError("otel is configured at creation"));
		// Snapshot schemas now, before asynchronous model/auth resolution yields to hosts.
		const captured = snapshotConfiguration(patch);
		const operation = this.configurationQueue.then(async () => {
			this.assertHealthy();
			const assembly = await this.prepareConfiguration(captured, refresh, this.configurationController.signal);
			try { this.assertHealthy(); } catch (error) { await assembly.mcp?.discard(); throw error; }
			const revision = ++this.revision;
			const applied = new Promise<Awaited<ConfigurationReceipt["applied"]>>(resolve => { this.pendingConfigurations.push({ assembly, revision, runBound: refresh || "skills" in captured || "memory" in captured, resolve }); });
			this.emit({ type: "configuration", phase: "accepted", revision, timestamp: Date.now() });
			if (!this.executing && !this.compactController) this.applyConfigurations();
			return { accepted: true as const, revision, applied };
		});
		this.configurationQueue = operation.then(() => { }, () => { });
		return operation;
	}
	private applyConfigurations(): void {
		while (this.pendingConfigurations.length && !(this.inChat && this.pendingConfigurations[0]!.runBound)) {
			const pending = this.pendingConfigurations.shift()!;
			if (this.disposed || this.failure !== undefined) { void pending.assembly.mcp?.discard().catch(() => { }); pending.resolve({ status: "canceled", revision: pending.revision }); continue; }

			pending.assembly.mcp?.commit(pending.revision);
			this.skills = { ...(pending.assembly.skills ?? emptySkills()), revision: pending.revision };
			this.skillSources = pending.assembly.skillSources ?? { snapshot: emptySkills() };
			this.requestProjection = undefined;
			this.appliedRevision = pending.revision;
			this.options = pending.assembly.options; this.tools = this.prepareTools(); this.driver = pending.assembly.driver;
			this.usage.invalidate(); this.compaction.syncUsage();
			pending.resolve({ status: "applied", revision: pending.revision });
			this.emit({ type: "configuration", phase: "applied", revision: pending.revision, timestamp: Date.now() });
		}
	}

	respond(response: ResponseEnvelope): boolean { this.assertHealthy(); return this.bus.respond(response); }
	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.disposed = true; this.configurationController.abort(); this.abort(); this.bus.close(); this.applyConfigurations();
		const active = this.active;
		this.disposing = (async () => {
			const outcomes = await Promise.allSettled([active?.iterator.return?.(), this.running, this.compacting, this.configurationQueue]);
			try {
				await this.options.mcpManager?.dispose();
				const error = outcomes.find(outcome => outcome.status === "rejected");
				if (error?.status === "rejected") throw error.reason;
				active?.finish();
			} catch (error) { active?.finish("error"); throw error; }
		})();
		return this.disposing;
	}
	private assertHealthy(): void { if (this.disposed) throw new Error("Agent has been disposed"); if (this.failure !== undefined) throw new Error("Agent is faulted; recreate it from storage", { cause: this.failure }); }
}
