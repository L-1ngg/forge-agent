import { chat, type ChatMiddleware, type TextOptions, type AnyTool, type Interrupt, type ModelMessage, type RunAgentResumeItem } from "@tanstack/ai";
import { createResourceTool, filter, withSkills } from "@tanstack/ai-skills";
import { memoryMiddleware } from "@tanstack/ai-memory";
import type { HarnessTool } from "@forge-agent/tools";
import { type SessionEvent, type SessionMessage, type ResponseEnvelope, type TurnResult } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import type { Agent, AgentTurn, InputAcceptance } from "./agent.ts";
import type { ConfigurationPatch, ConfigurationReceipt, SessionAssembly, SessionConfiguration } from "./configuration.ts";
import { snapshotConfiguration } from "./session-configuration.ts";
import { RequestBus } from "./request-bus.ts";
import { resolveProviderAdapter, providerModelOptions, type ModelAdapter } from "./model-adapter.ts";
import { toModelMessages } from "./model-response.ts";
import { observeModelResponse, linkedController } from "./model-call.ts";
import { transformMessages } from "./context/transform.ts";
import { checkRequestBudget, isolateRequest, requestFixedText, REQUEST_MARGIN, type RequestBudget } from "./context/request-budget.ts";
import { TurnPolicy } from "./turn-policy.ts";
import { explicitSkillBody, type PreparedSkills } from "./skills/source.ts";
import { calculateContextUsage, UsageTracker } from "./usage.ts";
import { emptySkills, SkillError, type SkillsSnapshot, type AgentInput } from "./skills/types.ts";
import { CompactionCoordinator } from "./context/coordinator.ts";
import { decorateToolEvent, type CommandPresentation } from "./event-projection.ts";
import type { BlockEnvelope } from "@forge-agent/protocol";
import { validateSessionTools, bridgeSessionTools, errorResult } from "./session-tools.ts";
import { contextReader } from "./context/read-context.ts";
import { contextSearcher } from "./context/search-context.ts";
import { messageEntry, ownSessionState, prepareSessionAppend, projectMessages, selectedBranch, sessionMessages, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { buildContext, resolveRetryPolicy, waitForRetry, DEFAULT_CONTEXT, type CompactionResult, type ContextSettings } from "./context/compaction.ts";
import { compactionInputBudget, type CompactionBudget } from "./context/compact.ts";
import { checkpointProjectionBudget } from "./context/checkpoint.ts";
import { createMemoryTools } from "./memory/tools.ts";
import { MarkdownMemoryAdapter } from "./memory/adapter.ts";
import { SessionInvocation } from "./session-invocation.ts";
import { SessionResponse } from "./session-response.ts";

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
	private async completeResponse(message: SessionMessage, current: SessionResponse): Promise<void> {
		this.lastResponse = message;
		if (!["error", "aborted", "length"].includes(message.stopReason ?? "")) { this.active?.resetFailures(); }
		if (this.settings.enabled && this.recoverableLength(message)) message.contextExcluded = true;
		await this.persistMessage(message);
		current.commit(message);
		this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
		await current.persistResults();
		if (["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "") || !message.content.some(block => block.type === "tool_call")) await this.completeTurn(current);
	}
	private async commitModelResponse(current: SessionResponse, messages: readonly ModelMessage[]): Promise<void> {
		if (current.committed || this.failure !== undefined) return;
		const message = current.message ?? current.project(messages);
		await this.completeResponse(message, current);
	}
	private async commitPartialResponse(current: SessionResponse | undefined, error: unknown, signal: AbortSignal): Promise<void> {
		if (!current?.audit || current.message || current.committed || this.failure !== undefined) return;
		const reason = signal.aborted || current.audit.reason === "aborted" ? "aborted" : current.audit.reason === "length" || current.audit.reason === "deferred" ? current.audit.reason : "error";
		const detail = reason === "aborted" ? "Request aborted" : reason === "error" ? current.audit.failure ?? (error instanceof Error ? error.message : String(error)) : undefined;
		await this.completeResponse(current.audit.partialMessage(reason, detail), current);
	}
	private async completeTurn(current: SessionResponse): Promise<void> {
		if (!current.complete()) return;
		const message = this.lastResponse!;
		this.emit({ type: "turn_end", ...(message.stopReason ? { stopReason: message.stopReason } : {}), timestamp: Date.now() });
		this.applyConfigurations();
		if (this.active?.policy && !["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "")) await this.active?.policy.evaluate({ message, toolResults: current.toolResults, model: structuredClone(current.options.model), configurationRevision: current.revision }, current.settings.signal);
	}
	private async runChat(signal: AbortSignal): Promise<void> {
		this.inChat = true;
		let current!: SessionResponse;
		let engineFailure: unknown;
		let continuation: { messages: ModelMessage[]; parentRunId: string; resume: RunAgentResumeItem[] } | undefined;
		let firstRequest = true;
		const source = this.skillSources.automatic;
		const explicitOnly = new Set(this.skills.entries.filter(entry => entry.status === "available" && entry.disableModelInvocation).map(entry => entry.name));
		const resource = this.skillSources.all ? createResourceTool(filter(this.skillSources.all, skill => !explicitOnly.has(skill.name) || this.explicitSkillNames.has(skill.name))) : undefined;
		const memory = this.options.memory ? { ...this.options.memory } : undefined;
		const latest = selectedBranch(this.state).reverse().find(entry => entry.type === "message" && entry.message.role === "user");
		const provenance = () => ({ kind: "session" as const, timestamp: latest?.timestamp ?? new Date().toISOString(), ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), ...(latest ? { entryId: latest.id } : {}) });
		const memoryAdapter = memory ? new MarkdownMemoryAdapter(memory, { ...this.options }, provenance, () => selectedBranch(this.state).filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError && (!latest || entry.timestamp >= latest.timestamp)).map(entry => JSON.stringify({ tool: entry.message.toolName, content: entry.message.content })).join("\n").slice(0, 4000), signal) : undefined;
		const memoryTools = memory ? createMemoryTools(memory.store, provenance) : [];
		const nativeTools = new Map<string, AnyTool>();
		if (resource) nativeTools.set(resource.name, resource);
		for (const tool of memoryTools) nativeTools.set(tool.name, tool);
		let forgePrompt: string | undefined;
		const routed: ModelAdapter = {
			kind: "text", name: "forge", model: this.options.model.id, "~types": undefined!,
			chatStream: (request: TextOptions) => {
				const snapshot = current;
				const self = this;
				return (async function*() {
					snapshot.settings.signal.throwIfAborted();
					const adapter = snapshot.options.adapter ?? await resolveProviderAdapter(snapshot.options.model, snapshot.settings);
					self.responseDriver = self.driver;
					const settle = self.active?.policy?.beginRequest();
					try {
						yield* observeModelResponse(adapter, { ...request, model: adapter.model }, snapshot.options, event => self.emit(event), audit => { snapshot.audit = audit; settle?.(audit.usage(snapshot.nativeUsage)); });
					} finally { settle?.(); }
				})();
			},
			structuredOutput: async () => { throw new Error("Task execution does not use separate structured finalization"); },
		};
		const middleware: ChatMiddleware = {
			name: "forge-session",
			onConfig: async (ctx, config) => {
				if (ctx.phase === "init" && continuation) return { tools: current.nativeTools };
				if (ctx.phase !== "beforeModel") return;
				signal.throwIfAborted(); this.lastResponse = undefined;
				// The first request's input was already prepared with a configuration
				// snapshot by runSession. Later requests are native tool continuations.
				if (!firstRequest) {
					this.applyConfigurations();
					for (const message of this.active!.drain("steer", this.options.steeringMode)) await this.consumeInput(message, signal);
				}
				const initialRequest = firstRequest;
				firstRequest = false;
				const baseNames = new Set(this.tools.map(tool => tool.name));
				for (const tool of config.tools) {
					if (baseNames.has(tool.name) && !nativeTools.has(tool.name)) {
						if (initialRequest) throw new Error(`Tool name collision: ${tool.name}`);
						continue;
					}
					if (!nativeTools.has(tool.name)) nativeTools.set(tool.name, tool);
				}
				const bridge = bridgeSessionTools(this.tools, nativeTools);
				const effectiveTools = bridge.effective;
				current = new SessionResponse(
					{ ...this.options, tools: effectiveTools }, this.appliedRevision,
					{ signal, maxTokens: this.compaction.taskMaxTokens(), ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}), ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), ...(this.options.thinkingLevel !== "off" ? { reasoning: this.options.thinkingLevel } : {}) },
					bridge.internal, () => sessionMessages(this.state), message => this.persistMessage(message), event => this.emit(event),
				);
				this.emit({ type: "turn_start", timestamp: Date.now() });
				const prompts = [...config.systemPrompts.filter(prompt => (typeof prompt === "string" ? prompt : prompt.content) !== forgePrompt), { content: current.options.systemPrompt }];
				forgePrompt = current.options.systemPrompt;
				const systemPrompt = prompts.map(prompt => typeof prompt === "string" ? prompt : prompt.content).join("\n\n");
				const fixedText = requestFixedText({ systemPrompt, tools: effectiveTools });
				const compactionBudget = this.compaction.budget(fixedText);
				const projection = await this.prepareRequestContext(signal, compactionBudget);
				const request = isolateRequest({ messages: projectMessages(projection), systemPrompt, tools: effectiveTools });
				try {
					const tokens = checkRequestBudget(request, this.requestBudget(compactionBudget), current.revision);
					if (this.requestProjection) this.requestProjection.tokens = tokens;
				} catch (error) { this.preparationFailed = true; throw error; }
				signal.throwIfAborted();
				const snapshot = current;
				const tools = bridge.bind((callId, args, original) => snapshot.execute(callId, args, original));
				current.nativeTools = tools;
				const messages = toModelMessages(projectMessages(sessionMessages(this.state)));
				current.baseMessageCount = messages.length;
				return { messages, providerMessages: toModelMessages(request.messages), systemPrompts: prompts, tools, modelOptions: providerModelOptions(current.options.model, current.settings) };
			},
			onUsage: (_ctx, usage) => { current.nativeUsage = usage; },
			onToolPhaseComplete: async (ctx, info) => {
				if (!current || signal.aborted || this.failure !== undefined) return;
				if (info.needsApproval.length) {
					await current.prepare(current.project(ctx.messages), info.needsApproval);
					return;
				}
				current.message ??= current.project(ctx.messages);
				for (const call of current.pendingResults()) {
					const denial = current.denial(call.id);
					const native = info.results.find(result => result.toolCallId === call.id);
					const prior = ctx.messages.find(message => message.role === "tool" && message.toolCallId === call.id);
					const result = errorResult(denial ?? (native ? JSON.stringify(native.result) : prior ? typeof prior.content === "string" ? prior.content : JSON.stringify(prior.content) : "Tool was not executed"));
					current.recordResult(call, result);
				}
				await this.commitModelResponse(current, ctx.messages);
				await this.completeTurn(current);
				if (this.active?.policy?.stopped) ctx.abort("forge:policy_stop");
			},
			onShouldContinue: async ctx => {
				// TanStack skips beforeTools and onToolPhaseComplete when every call
				// already has a native error result. Save both sides before its next model request.
				if (current?.audit?.hasTools && !current.message && !current.committed && !signal.aborted && this.failure === undefined) {
					current.message ??= current.project(ctx.messages);
					for (const call of current.pendingResults()) {
						const native = ctx.messages.find(message => message.role === "tool" && message.toolCallId === call.id);
						const detail = native ? typeof native.content === "string" ? native.content : JSON.stringify(native.content) : "Tool was not executed";
						current.recordResult(call, errorResult(detail));
					}
					await this.commitModelResponse(current, ctx.messages);
					await this.completeTurn(current);
				}
				return !signal.aborted && !this.active?.policy?.stopped && !this.active?.policy?.failed && !this.preparationFailed;
			},
			onFinish: async ctx => { if (current?.audit && !current.audit.hasTools && !current.committed) await this.commitModelResponse(current, ctx.messages); },
			onError: async (_ctx, info) => { engineFailure = info.error; await this.commitPartialResponse(current, info.error, signal); },
			onAbort: async () => { await this.commitPartialResponse(current, new Error("Request aborted"), signal); },
		};
		const linked = linkedController(signal);
		try {
			// Session events carry failures; native console logging would corrupt JSON
			// stdout and duplicate the same provider error outside the host contract.
			const nativeMiddleware = memoryAdapter ? memoryMiddleware({
				adapter: memoryAdapter, scope: { threadId: this.options.sessionId ?? "session" }, role: memory?.injection === false ? "save-only" : "recall+save",
				onRecall: ({ result }) => this.emit({ type: "memory", phase: "recall", selected: result.fragments?.map(fragment => fragment.source) ?? [], timestamp: Date.now() }),
				onSave: ({ receipts }) => this.emit({ type: "memory", phase: "save", status: receipts.some(receipt => !receipt.ok) ? "failed" : receipts.length ? "saved" : "skipped", calls: memoryAdapter.organizerCalls, ...(memoryAdapter.organizerUsage ? { usage: memoryAdapter.organizerUsage } : {}), receipts: receipts.map(receipt => ({ ok: receipt.ok, ...(receipt.error ? { error: receipt.error } : {}), ...(receipt.raw ? { raw: receipt.raw } : {}) })), timestamp: Date.now() }),
			}) : undefined;
			const middlewareChain = [...(nativeMiddleware ? [nativeMiddleware] : []), ...(source ? [withSkills(source)] : []), middleware];
			const threadId = this.options.sessionId ?? randomUUID();
			while (!signal.aborted) {
				const runId = randomUUID();
				let snapshot: ModelMessage[] | undefined;
				let interrupts: readonly Interrupt[] | undefined;
				for await (const chunk of chat({
					adapter: routed, messages: continuation?.messages ?? toModelMessages(projectMessages(this.messages())),
					threadId, runId, ...(continuation ? { parentRunId: continuation.parentRunId, resume: continuation.resume } : {}),
					abortController: linked.controller, tools: continuation?.messages ? current.nativeTools : [...(resource ? [resource] : []), ...memoryTools],
					middleware: middlewareChain, agentLoopStrategy: () => true, debug: false,
				})) {
					if (chunk.type === "MESSAGES_SNAPSHOT") snapshot = chunk.messages as unknown as ModelMessage[];
					if (chunk.type === "RUN_FINISHED" && chunk.outcome?.type === "interrupt") interrupts = chunk.outcome.interrupts;
				}
				if (!interrupts) break;
				if (!snapshot) throw new Error("Native interrupt has no messages snapshot");
				const resume = await current.approve(interrupts, this.bus);
				continuation = { messages: snapshot, parentRunId: runId, resume };
			}
		} catch (error) { engineFailure = error; }
		finally { linked.dispose(); this.inChat = false; this.applyConfigurations(); }
		if (this.failure !== undefined) throw this.failure;
		if (current?.message && !current.committed) {
			for (const call of current.pendingResults()) current.recordResult(call, errorResult(current.denial(call.id) ?? (signal.aborted ? "Operation aborted" : engineFailure ?? "Tool was not executed")));
			await this.completeResponse(current.message, current);
		}
		if (signal.aborted && this.lastResponse?.stopReason !== "aborted" && (!this.lastResponse || this.lastResponse.content.some(part => part.type === "tool_call"))) {
			await this.recordFailure(signal.reason ?? new Error("Request aborted"), signal);
			return;
		}
		if (engineFailure !== undefined && (!this.lastResponse || !["error", "aborted", "length", "deferred"].includes(this.lastResponse.stopReason ?? ""))) {
			if (!this.lastResponse) this.preparationFailed = true;
			await this.recordFailure(engineFailure, signal);
		}
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
