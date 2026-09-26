import { transformMessages } from "./context/transform.ts";
import { checkRequestBudget, isolateRequest, REQUEST_MARGIN, type RequestBudget } from "./context/request-budget.ts";
import { TurnPolicy } from "./turn-policy.ts";
import { loadSkill } from "./skills/load.ts";
import { calculateContextUsage } from "./usage.ts";
import { skillLoader, validateSkillArguments } from "./skills/tools.ts";
import { emptySkills, SkillError, type SkillsSnapshot, type AgentInput, type SkillInvocation } from "./skills/types.ts";
import { CompactionCoordinator } from "./context/coordinator.ts";
import type { ConfigurationPatch, ConfigurationReceipt, SessionAssembly, SessionToolset } from "./configuration.ts";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import type { AgentMessage } from "./runtime/types.ts";
import { Agent as RuntimeAgent } from "./runtime/agent.ts";
import { fromSessionMessage, createEventProjection, toSessionMessage } from "./event-projection.ts";
import type { AgentPort, InputAcceptance } from "./agent-port.ts";
import type { ModelPortOptions } from "./session-port.ts";
import { prepareSessionTools, validateSessionTools, checkPermission, preserveToolSchemas } from "./session-tools.ts";
import { snapshotConfiguration } from "./session-configuration.ts";
import { contextReader } from "./context/read-context.ts";
import { contextSearcher } from "./context/search-context.ts";
import { MemorySessionStorage, messageEntry, projectMessages, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { randomUUID } from "node:crypto";
import { resolveRetryPolicy, waitForRetry, DEFAULT_CONTEXT, type CompactionResult, type ContextSettings } from "./context/compaction.ts";
import { compactionInputBudget } from "./context/compact.ts";
import { UsageTracker } from "./usage.ts";
import { MemoryTools } from "./memory/tools.ts";
import { selectedBranch } from "./session-storage.ts";
import { ContextAssembler, memoryInjectionBudget } from "./context/assembler.ts";

/** Owns durable history and run settlement; the runtime alone owns request messages. */
export class AgentSession implements AgentPort {
	private skills: SkillsSnapshot;
	private readonly runtime: RuntimeAgent;
	private readonly compaction: CompactionCoordinator;
	private readonly projectEvent = createEventProjection();
	private options: ModelPortOptions;
	private toolset: SessionToolset;
	private driver: SessionAssembly["driver"];
	private preparationFailed = false;
	private requestProjection: { messages: SessionMessage[]; tokens?: number; contextWindow: number } | undefined;
	private publishedMemory: string | undefined;
	private responseDriver: SessionAssembly["driver"] | undefined;
	private disposed = false;
	private executing = false;
	private revision = 0;
	private appliedRevision = 0;
	private turnPolicy: TurnPolicy | undefined;
	private taskUsage: ((usage?: SessionMessage["usage"]) => void) | undefined;
	private responseConfiguration: { model: ModelPortOptions["model"]; configurationRevision: number } | undefined;
	private readonly configurationController = new AbortController();
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
	private readonly preparedSkills = new WeakSet<AgentMessage>();
	private readonly stagedMcp = new Map<AgentMessage, string[]>();
	private skillInputs = new Map<AgentMessage, { invocation: Exclude<AgentInput, string>; inputId: string }>();
	private receipts = new Map<AgentMessage, (processed: boolean) => void>();
	private failure: unknown;
	private readonly usage: UsageTracker;
	private running: Promise<void> | undefined;
	private emit: (event: SessionEvent) => void = () => { };
	private readonly memoryTools: MemoryTools | undefined;
	private readonly assembler: ContextAssembler;
	private memoryWriteMode: boolean | undefined;

	constructor(assembly: SessionAssembly, private readonly prepareConfiguration: (patch: ConfigurationPatch, refresh?: boolean, signal?: AbortSignal) => Promise<SessionAssembly>) {
		this.skills = assembly.skills ?? emptySkills();
		this.options = assembly.options; this.driver = assembly.driver;
		const options = this.options;
		this.assembler = new ContextAssembler(options.memory);
		if (options.memory) this.memoryTools = new MemoryTools(options.memory, () => {
			const entry = selectedBranch(this.state).reverse().find(entry => entry.type === "message" && entry.message.role === "user");
			return { kind: "session", timestamp: entry?.timestamp ?? new Date().toISOString(), ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(entry ? { entryId: entry.id } : {}) };
		}, () => this.getMemoryBudget());

		this.settings = { ...DEFAULT_CONTEXT, ...options.context };
		this.configureContext(options.context ?? {});
		this.toolset = this.prepareTools();
		const toolset = this.toolset;
		this.storage = new MemorySessionStorage(options.history);
		this.usage = new UsageTracker({ contextWindow: options.contextWindow ?? options.model.contextWindow });
		this.runtime = new RuntimeAgent({
			prepareInputMessage: (message, signal) => this.prepareInputMessage(message, signal),
			...(options.steeringMode ? { steeringMode: options.steeringMode } : {}),
			...(options.followUpMode ? { followUpMode: options.followUpMode } : {}),
			initialState: { model: options.model, systemPrompt: options.systemPrompt, thinkingLevel: options.thinkingLevel, tools: toolset?.tools ?? [] },
			beforeToolCall: (context, signal) => this.toolset.beforeToolCall?.(context, signal) ?? Promise.resolve(undefined),
			afterToolCall: (context, signal) => this.toolset.afterToolCall?.(context, signal) ?? Promise.resolve(undefined),
			...(toolset.toolExecution ? { toolExecution: toolset.toolExecution } : {}),
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
			shouldStopAfterTurn: ({ message, toolResults }, signal) => {
				if (!this.turnPolicy) return false;
				return this.turnPolicy.evaluate({
					message: toSessionMessage(message)!, toolResults: toolResults.map(result => toSessionMessage(result)!),
					...this.responseConfiguration!,
				}, signal!);
			},
			shouldStopAfterResponse: ({ message }) => message.stopReason === "length" || message.stopReason === "deferred",
			prepareNextTurnWithContext: () => {
				this.applyConfigurations();
				if (this.memoryTools && this.memoryWriteMode !== (this.memoryTools.options.autoUpdate !== false)) {
					this.toolset.clear(); this.toolset = this.prepareTools(); this.runtime.state.tools = this.toolset.tools;
					this.usage.invalidate();
				}
				return { context: { systemPrompt: this.runtime.state.systemPrompt, tools: this.runtime.state.tools, messages: this.runtime.state.messages.slice() }, model: this.options.model, thinkingLevel: this.options.thinkingLevel };
			},
			transformContext: (_messages, signal) => this.prepareRequestContext(signal ?? this.runController!.signal),
			convertToLlm: messages => {
				try { return projectMessages(messages.map(message => toSessionMessage(message)!)).map(message => fromSessionMessage(message, this.options.model)); }
				catch (error) { this.preparationFailed = true; throw error; }
			},
			streamFn: (model, context, settings) => {
				settings?.signal?.throwIfAborted();
				try {
					context = isolateRequest(context);
					const tokens = checkRequestBudget(context, this.requestBudget(), this.appliedRevision);
					if (this.requestProjection) this.requestProjection.tokens = tokens;
				} catch (error) { this.preparationFailed = true; throw error; }
				settings?.signal?.throwIfAborted();
				this.responseDriver = this.driver;
				if (this.turnPolicy) {
					this.responseConfiguration = { model: structuredClone(model), configurationRevision: this.appliedRevision };
					this.taskUsage = this.turnPolicy.beginRequest();
				}
				return this.options.streamFn(model, context, { ...settings, ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}), maxRetries: 0, maxTokens: this.compaction.taskMaxTokens(), ...(this.options.builtinStream && model.provider === "openai" ? {} : { onPayload: async (payload, model) => preserveToolSchemas(await settings?.onPayload?.(payload, model) ?? payload, this.options.tools) }) });
			},
		});
		this.compaction = new CompactionCoordinator({
			runtime: this.runtime, usage: this.usage, assembler: this.assembler,
			configuration: () => ({ options: this.options, driver: this.summaryDriver(), settings: this.settings }),
			history: () => this.state, persist: entry => this.persistEntry(entry), isFaulted: () => this.failure !== undefined,
		});
		this.runtime.subscribe(async event => {
			// Agent reduces state before awaited listeners, and reports listener failures as
			// run failures. A failed store must never be re-entered by that error reporting.
			if (this.failure !== undefined) throw this.failure;
			if (event.type === "message_start" && event.message.role === "user") {
				this.runController?.signal.throwIfAborted();
				if (!this.preparedSkills.has(event.message)) { this.receipts.get(event.message)?.(true); this.receipts.delete(event.message); }
			}
			if (event.type === "message_end") {
				this.requestProjection = undefined;
				if (event.message.role === "user") this.recoveryUsed = false;
				const message = toSessionMessage(event.message);
				if (message?.role === "assistant") { this.taskUsage?.(message.usage); this.taskUsage = undefined; }
				if (message?.role === "assistant" && !["error", "aborted", "length"].includes(message.stopReason ?? "")) { this.taskFailures = 0; this.recoveryUsed = false; }
				if (message && this.settings.enabled && this.recoverableLength(message)) { message.contextExcluded = true; Object.assign(event.message, { contextExcluded: true }); }
				if (message) {
					const entry = messageEntry(message, this.state.leafId);
					if (!this.preparedSkills.has(event.message)) { this.receipts.get(event.message)?.(true); this.receipts.delete(event.message); }
					// Append now owns any artifact references, including an uncertain storage outcome.
					this.stagedMcp.delete(event.message);
					await this.persistEntry(entry);
					if (this.preparedSkills.has(event.message)) { this.receipts.get(event.message)?.(true); this.receipts.delete(event.message); this.preparedSkills.delete(event.message); }
					this.compaction.syncUsage();
					if (message.usage) this.usage.recordUsage(message.usage, !this.options.transformContext);
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
		this.compaction.rebuild();
	}
	runTurn(input: AgentInput, inputId?: string): AsyncIterable<SessionEvent> { return this.run(input, inputId); }
	continue(): AsyncIterable<SessionEvent> { return this.run(); }
	private async *run(input?: AgentInput, inputId?: string): AsyncIterable<SessionEvent> {
		this.assertHealthy();
		if (this.running) throw new Error("Agent is already processing a turn");
		if (!this.initialized) await this.setStorage(this.storage);
		const events: SessionEvent[] = [];
		let wake: (() => void) | undefined;
		let done = false;
		let failure: unknown;
		this.emit = event => { events.push(structuredClone(event)); wake?.(); };
		this.usage.beginTurn(); this.accepting = true;
		this.turnPolicy = this.options.shouldStopAfterTurn ? new TurnPolicy(this.options.shouldStopAfterTurn) : undefined;
		this.taskUsage = undefined; this.responseConfiguration = undefined;
		this.preparationFailed = false; this.requestProjection = undefined;
		this.runController = new AbortController();
		this.memoryTools?.reset();
		const running = this.runSession(input, this.runController.signal, inputId)
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
			this.turnPolicy = undefined; this.taskUsage = undefined; this.responseConfiguration = undefined;
			this.requestProjection = undefined;
			this.compaction.syncUsage(); this.usage.endTurn();
			if (failure !== undefined) throw failure;
		}
	}
	steer(input: AgentInput, inputId?: string): InputAcceptance { return this.enqueue(input, "steer", inputId); }
	followUp(input: AgentInput, inputId?: string): InputAcceptance { return this.enqueue(input, "followUp", inputId); }
	private enqueue(input: AgentInput, mode: "steer" | "followUp", inputId?: string): InputAcceptance {
		this.assertHealthy();
		if (!this.accepting) return { accepted: false };
		const message = this.inputMessage(input, inputId);
		const processed = new Promise<boolean>(resolve => { this.receipts.set(message, resolve); });
		this.runtime[mode](message);
		return { accepted: true, processed, ...(inputId ? { inputId } : {}) };
	}
	private inputMessage(input: AgentInput, inputId?: string): AgentMessage {
		const message: AgentMessage = { role: "user", content: [{ type: "text", text: typeof input === "string" ? input : "" }], timestamp: Date.now() };
		if (typeof input !== "string") this.skillInputs.set(message, { invocation: structuredClone(input), inputId: inputId ?? randomUUID() });
		return message;
	}
	private async prepareInputMessage(message: AgentMessage, signal?: AbortSignal): Promise<void> {
		const selected = this.skillInputs.get(message);
		try {
			signal?.throwIfAborted(); this.runController?.signal.throwIfAborted();
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
				const args = { name: invocation.name }; validateSkillArguments(args);
				const check = await checkPermission({ type: "tool_call", id: inputId, name: "load_skill", arguments: args }, { context: this.options.permission ?? {}, ...(this.options.requestBus ? { requestBus: this.options.requestBus } : {}) }, signal);
				if (!check.allowed) throw new SkillError("permission-denied", check.reason);
				const loaded = await loadSkill(this.skills, invocation.name, true, signal);
				const { body, ...source } = loaded;
				message.content = [{ type: "text", text: `Skill instructions (${JSON.stringify(source)}):\n${body}\n\nUser task:\n${invocation.task}` }];
				}
			}
			signal?.throwIfAborted(); this.runController?.signal.throwIfAborted();
			if (this.skills.enabled || selected?.invocation.kind === "mcp_prompt" || selected?.invocation.kind === "mcp_resource") {
				const budget = this.compaction.budget();
				const size = calculateContextUsage({ fixedText: budget.fixedText, messages: projectMessages([toSessionMessage(message)!]) }).contextTokens ?? 0;
				if (size > compactionInputBudget(budget, this.settings.reserveTokens)) throw new SkillError("too-large", "Skills and input exceed context budget; reduce Skill sources or split instructions into references.");
			}
			if (selected) this.preparedSkills.add(message);
		} catch (error) {
			if (selected) {
				const code = signal?.aborted || this.runController?.signal.aborted ? "canceled" : error instanceof SkillError ? error.code : "read-failed";
				if (selected.invocation.kind === "skill") this.emit({ type: "skill_input", phase: "rejected", inputId: selected.inputId, name: selected.invocation.name, code, message: String(error), timestamp: Date.now() });
				this.receipts.get(message)?.(false); this.receipts.delete(message);
			}
			throw error;
		} finally { this.skillInputs.delete(message); }
	}
	private closeInput(): void {
		this.accepting = false; this.runtime.clearAllQueues();
		for (const resolve of this.receipts.values()) resolve(false);
		this.receipts.clear(); this.skillInputs.clear();
	}
	abort(): void { this.runController?.abort(); this.compactController?.abort(); this.closeInput(); this.runtime.abort(); this.options.requestBus?.abort(); }
	getUsage() {
		const snapshot = this.usage.snapshot(), request = this.requestProjection;
		return request?.tokens === undefined ? snapshot : { ...snapshot, contextTokens: request.tokens, contextWindow: request.contextWindow, contextEstimated: true };
	}
	getMemoryBudget(): number {
		if (this.options.memory?.injection === false) return 0;
		return memoryInjectionBudget(this.requestProjection?.messages ?? projectMessages(this.runtime.state.messages.map(message => toSessionMessage(message)!)), this.compaction.budget().fixedText, compactionInputBudget(this.compaction.budget(), this.settings.reserveTokens));
	}

	private requestBudget(): RequestBudget {
		const budget = this.compaction.budget();
		return { contextWindow: budget.window, inputBudget: compactionInputBudget(budget, this.settings.reserveTokens), maxInputTokens: budget.window - budget.output - REQUEST_MARGIN,
			fixedTokens: Math.ceil(budget.fixedText.length / 4), maxTokens: this.compaction.taskMaxTokens(), effectiveOutputTokens: budget.output };
	}
	private async prepareRequestContext(signal: AbortSignal): Promise<AgentMessage[]> {
		try {
			signal.throwIfAborted(); this.requestProjection = undefined;
			const history = () => projectMessages(this.runtime.state.messages.map(message => toSessionMessage(message)!));
			await this.assembleMemory(history(), signal, false); this.compaction.syncUsage();
			const budget = this.requestBudget();
			if (this.settings.enabled && (this.getUsage().contextTokens ?? 0) > budget.inputBudget) {
				const result = await this.compaction.run("threshold", signal, this.emit);
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
			await this.assembleMemory(messages, signal, true);
			signal.throwIfAborted();
			return [...this.assembler.projection.messages, ...messages].map(message => fromSessionMessage(message, this.options.model));
		} catch (error) {
			this.requestProjection = undefined;
			signal.throwIfAborted();
			this.preparationFailed = true;
			throw error;
		}
	}
	private async assembleMemory(messages: SessionMessage[], signal: AbortSignal, publish: boolean): Promise<void> {
		this.publishedMemory ??= JSON.stringify(this.assembler.projection);
		const latest = selectedBranch(this.state).reverse().find(entry => entry.type === "message" && entry.message.role === "user");
		const before = JSON.stringify(this.assembler.projection);
		const projection = await this.assembler.assemble(messages, this.compaction.budget().fixedText, compactionInputBudget(this.compaction.budget(), this.settings.reserveTokens), `${latest?.id}:${this.memoryTools?.revision}`, signal);
		const serialized = JSON.stringify(projection);
		if (serialized !== before) this.usage.invalidate();
		if (publish && serialized !== this.publishedMemory) {
			this.publishedMemory = serialized;
			this.emit({ type: "memory", phase: "projection", tokens: projection.tokens, truncated: projection.truncated, selected: projection.selected, warnings: projection.warnings, timestamp: Date.now() });
		}
	}
	private prepareTools(): SessionToolset {
		this.memoryWriteMode = this.memoryTools?.options.autoUpdate !== false;
		validateSessionTools(this.options);
		return prepareSessionTools({ ...this.options, tools: [...(this.options.tools ?? []), ...(this.skills.enabled ? [skillLoader(this.skills)] : []), contextReader(() => this.state), contextSearcher(() => this.state), ...(this.memoryTools?.tools() ?? [])] });
	}
	configureContext(settings: Partial<ContextSettings>): void {
		if (this.running || this.compactController) throw new Error("Cannot configure context during execution");
		const next = { ...this.settings, ...settings };
		if ("strategy" in next || !Number.isInteger(next.reserveTokens) || next.reserveTokens < 1 || !Number.isInteger(next.keepRecentTokens) || next.keepRecentTokens < 1 || typeof next.enabled !== "boolean" || !["inherit", "off"].includes(next.summaryReasoning)) throw new Error("Invalid context settings");
		if (this.options.tools?.some(tool => ["read_context", "search_context"].includes(tool.name))) throw new Error("read_context and search_context are reserved by context compaction");
		this.settings = next;
		if (this.runtime) {
			this.toolset.clear(); this.toolset = this.prepareTools(); this.runtime.state.tools = this.toolset.tools;
			this.compaction.rebuild();
		}
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
		try { return await this.compaction.run("manual", controller.signal, emit, instructions); }
		finally { signal?.removeEventListener("abort", abort); this.compactController = undefined; this.applyConfigurations(); }
	}

	private async persistEntry(entry: SessionEntry): Promise<void> {
		try { await this.storage.append(structuredClone(entry)); }
		catch (error) { this.failure = error; this.abort(); throw error; }
		this.state.entries.push(entry); this.state.leafId = entry.id;
	}

	private summaryDriver(): SessionAssembly["driver"] {
		const driver = this.driver, policy = this.turnPolicy;
		if (!policy || !driver.summarize) return driver;
		const summarize = driver.summarize.bind(driver);
		return { ...driver, summarize: async (request, signal) => {
			const settle = policy.beginRequest();
			try { const response = await summarize(request, signal); settle(response.usage); return response; }
			finally { settle(); }
		} };
	}

	private recoverableLength(message: SessionMessage): boolean {
		const driver = this.responseDriver ?? this.driver;
		return message.stopReason === "length" && (driver.maxTokens ?? 0) > 0 && message.usage !== undefined && message.usage.output < driver.maxTokens!;
	}
	private async runSession(input: AgentInput | undefined, signal: AbortSignal, inputId?: string): Promise<void> {
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
				if (first && input !== undefined) await this.runtime.prompt(this.inputMessage(input, inputId));
				else await this.runtime.continue();
				first = false;
				if (this.failure !== undefined) throw this.failure;
				if (signal.aborted || this.preparationFailed || this.turnPolicy?.stopped || this.turnPolicy?.failed) return;
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
					const result = await this.compaction.run(reason, signal, this.emit);
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
					this.usage.invalidate(); this.compaction.syncUsage();
					this.emit({ type: "retry", phase: "attempt", attempt, timestamp: Date.now() });
					continue;
				}
				if (message.stopReason !== "error" && message.stopReason !== "length" && message.stopReason !== "aborted") this.recoveryUsed = false;
				if (this.settings.enabled && message.stopReason === "stop" && overflow) await this.compaction.run("usage", signal, this.emit);
				return;
			}
		} finally {
			this.closeInput();
			for (const [message, ids] of this.stagedMcp) { this.stagedMcp.delete(message); await Promise.all(ids.map(id => this.options.mcpManager?.artifacts.delete?.(id))); }
			this.executing = false; this.applyConfigurations();
			const last = this.runtime.state.messages.at(-1);
			const reason = last?.role === "assistant" ? last.stopReason : undefined;
			const outcome = this.failure !== undefined ? "error" : signal.aborted ? "aborted" : (this.preparationFailed || this.turnPolicy?.failed) ? "error" : reason === "error" || reason === "aborted" || reason === "length" || reason === "deferred" ? reason : "success";
			if (retried) this.emit({ type: "retry", phase: "end", attempt: lastRetryAttempt, outcome: outcome === "success" ? "success" : outcome === "aborted" ? "aborted" : "error", timestamp: Date.now() });
			this.emit({ type: "agent_end", outcome, ...(outcome === "success" && this.turnPolicy?.stopped ? { terminationReason: "policy" as const } : {}), timestamp: Date.now() });
		}
	}

	get mcp() { return this.options.mcpManager!; }
	getSkills(): SkillsSnapshot { return structuredClone(this.skills); }
	refreshSkills(): Promise<ConfigurationReceipt> { return this.updateConfiguration({}, true); }
	updateConfiguration(patch: ConfigurationPatch, refresh = false): Promise<ConfigurationReceipt> {
		this.assertHealthy();
		if (patch.mcp && Object.keys(patch.mcp).some(key => !["enabled", "servers"].includes(key))) return Promise.reject(new TypeError("MCP stores and interaction are configured at creation"));
		if ("transformContext" in patch) return Promise.reject(new TypeError("transformContext is configured at creation"));
		if ("shouldStopAfterTurn" in patch) return Promise.reject(new TypeError("shouldStopAfterTurn is configured at creation"));
		// Snapshot schemas now, before asynchronous model/auth resolution yields to hosts.
		const captured = snapshotConfiguration(patch);
		const operation = this.configurationQueue.then(async () => {
			this.assertHealthy();
			const assembly = await this.prepareConfiguration(captured, refresh, this.configurationController.signal);
			try { this.assertHealthy(); } catch (error) { await assembly.mcp?.discard(); throw error; }
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
			if (this.disposed || this.failure !== undefined) { void pending.assembly.mcp?.discard().catch(() => {}); pending.resolve({ status: "canceled", revision: pending.revision }); continue; }
			this.toolset.clear();
			pending.assembly.mcp?.commit(pending.revision);
			this.skills = { ...(pending.assembly.skills ?? emptySkills()), revision: pending.revision };
			this.requestProjection = undefined;
			this.appliedRevision = pending.revision;
			this.options = pending.assembly.options; this.toolset = this.prepareTools(); this.driver = pending.assembly.driver;
			this.runtime.state.model = this.options.model; this.runtime.state.systemPrompt = this.options.systemPrompt;
			this.runtime.state.thinkingLevel = this.options.thinkingLevel; this.runtime.state.tools = this.toolset.tools;
			this.usage.invalidate(); this.compaction.syncUsage();
			pending.resolve({ status: "applied", revision: pending.revision });
			this.emit({ type: "configuration", phase: "applied", revision: pending.revision, timestamp: Date.now() });
		}
	}
	async dispose(): Promise<void> { this.disposed = true; this.configurationController.abort(); this.abort(); this.applyConfigurations(); await this.running; await this.configurationQueue; await this.options.mcpManager?.dispose(); }
	private assertHealthy(): void { if (this.disposed) throw new Error("Agent has been disposed"); if (this.failure !== undefined) throw new Error("Agent is faulted; recreate it from storage", { cause: this.failure }); }
}
