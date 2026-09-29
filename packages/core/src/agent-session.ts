import { chat, toolDefinition, convertSchemaToJsonSchema, parseWithStandardSchema, readInterruptBinding, type ChatMiddleware, type TextOptions, type JSONSchema, type AnyTool, type Interrupt, type ModelMessage, type RunAgentResumeItem, type TokenUsage } from "@tanstack/ai";
import { z } from "zod";
import { createResourceTool, filter, withSkills } from "@tanstack/ai-skills";
import { memoryMiddleware } from "@tanstack/ai-memory";
import type { HarnessTool } from "@forge-agent/tools";
import { serializePermissionArguments, type SessionEvent, type SessionMessage, type ResponseEnvelope, type RequestOutcome, type ToolCallBlock, type TurnResult } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import type { Agent, AgentTurn, InputAcceptance } from "./agent.ts";
import type { ConfigurationPatch, ConfigurationReceipt, SessionAssembly, SessionConfiguration } from "./configuration.ts";
import { snapshotConfiguration } from "./session-configuration.ts";
import { RequestBus } from "./request-bus.ts";
import { resolveProviderAdapter, providerModelOptions, type ModelAdapter, type ModelRequestSettings } from "./model-adapter.ts";
import { isProviderExecutedCall, toModelMessages, type RawResponseAudit } from "./model-response.ts";
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
import { validateSessionTools, prepareToolCall, decideEditedArgs, rememberPermission, executePreparedTool, errorResult, snapshot, type PreparedToolCall } from "./session-tools.ts";
import { contextReader } from "./context/read-context.ts";
import { contextSearcher } from "./context/search-context.ts";
import { messageEntry, projectMessages, selectedBranch, sessionMessages, type SessionEntry, type SessionState, type SessionStorage } from "./session-storage.ts";
import { buildContext, resolveRetryPolicy, waitForRetry, DEFAULT_CONTEXT, type CompactionResult, type ContextSettings } from "./context/compaction.ts";
import { compactionInputBudget, type CompactionBudget } from "./context/compact.ts";
import { createMemoryTools } from "./memory/tools.ts";
import { MarkdownMemoryAdapter } from "./memory/adapter.ts";

interface ActiveTurn {
	id: symbol; begun: boolean; canceled: boolean; iterator: AsyncIterator<SessionEvent>;
	settled: Promise<void>; finish(status?: TurnResult["status"]): void; outcome?: TurnResult;
}
interface ResponseSnapshot {
	options: SessionConfiguration; revision: number; settings: ModelRequestSettings;
	internalTools: ReadonlySet<HarnessTool<object, unknown>>;
	prepared: Map<string, PreparedToolCall>; savedResults: Set<string>; startedTools: Set<string>; toolResults: SessionMessage[];
	nativeTools: AnyTool[]; completed: boolean; committed: boolean; baseMessageCount: number;
	audit?: RawResponseAudit; nativeUsage?: TokenUsage;
}
interface PendingApprovalBatch {
	requestIds: Set<string>; remaining: number; sealed: boolean; finish(): void;
}
const approvalSchema = { reject: z.object({ reason: z.string() }) };

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
	private turnPolicy: TurnPolicy | undefined;
	private readonly configurationController = new AbortController();
	private configurationQueue: Promise<void> = Promise.resolve();
	private pendingConfigurations: Array<{ assembly: SessionAssembly; revision: number; runBound: boolean; resolve: (value: Awaited<ConfigurationReceipt["applied"]>) => void; }> = [];
	private state: SessionState;
	private settings: ContextSettings;
	private compactController: AbortController | undefined;
	private compacting: Promise<CompactionResult> | undefined;
	private runController: AbortController | undefined;
	private recoveryUsed = false;
	private taskFailures = 0;
	private accepting = false;
	private readonly preparedSkills = new WeakSet<SessionMessage>();
	private readonly explicitSkillNames = new Set<string>();
	private readonly stagedMcp = new Map<SessionMessage, string[]>();
	private skillInputs = new Map<SessionMessage, { invocation: Exclude<AgentInput, string>; inputId: string; }>();
	private receipts = new Map<SessionMessage, (processed: boolean) => void>();
	private readonly steering: SessionMessage[] = [];
	private readonly followups: SessionMessage[] = [];
	private failure: unknown;
	private readonly usage: UsageTracker;
	private active: ActiveTurn | undefined;
	private pendingApproval: PendingApprovalBatch | undefined;
	private running: Promise<void> | undefined;
	private emit: (event: SessionEvent) => void = () => { };

	constructor(assembly: SessionAssembly, private readonly storage: SessionStorage, private readonly bus: RequestBus, state: SessionState,
		private readonly prepareConfiguration: (patch: ConfigurationPatch, refresh?: boolean, signal?: AbortSignal) => Promise<SessionAssembly>) {
		this.requests = bus.requests();
		this.state = structuredClone(state); selectedBranch(this.state);
		this.skills = assembly.skills ?? emptySkills();
		this.skillSources = assembly.skillSources ?? { snapshot: emptySkills() };
		this.options = assembly.options; this.driver = assembly.driver;
		const options = this.options;
		this.settings = { ...DEFAULT_CONTEXT, ...options.context };
		this.tools = this.prepareTools();
		this.usage = new UsageTracker({ contextWindow: options.contextWindow ?? options.model.contextWindow });
		this.compaction = new CompactionCoordinator({
			messages: () => this.messages(), tools: () => this.tools, usage: this.usage,
			configuration: () => ({ options: this.options, driver: this.summaryDriver(), settings: this.settings }),
			history: () => this.state, persist: entry => this.persistEntry(entry), isFaulted: () => this.failure !== undefined,
		});
		this.configureContext(options.context ?? {});
	}
	private messages(): SessionMessage[] { return buildContext(this.state); }
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
				let resolveIdle!: () => void, closed = false;
				const settled = new Promise<void>(resolve => { resolveIdle = resolve; });
				const active: ActiveTurn = {
					id, begun: false, canceled: false, settled, iterator: undefined!, finish: status => {
						if (closed) return;
						closed = true;
						if (this.active === active) this.active = undefined;
						resolveResult(status ? { status } : active.outcome ?? { status: "aborted" }); resolveIdle();
					}
				};
				const iterator = this.events(active, input, inputId)[Symbol.asyncIterator](); active.iterator = iterator; this.active = active;
				return {
					next: async () => {
						if (closed) return { done: true, value: undefined };
						if ((active.canceled || this.disposed) && !active.begun) { active.finish("aborted"); return { done: true, value: undefined }; }
						active.begun = true;
						try { const next = await iterator.next(); if (next.done) active.finish(); return next; }
						catch (error) { active.finish("error"); throw error; }
					},
					return: async () => {
						if (closed) return { done: true, value: undefined };
						active.canceled = true; this.abort();
						try { return await iterator.return?.() ?? { done: true, value: undefined }; }
						catch (error) { active.finish("error"); throw error; }
						finally { active.finish(); }
					},
				};
			}
		};
	}
	private async *events(active: ActiveTurn, input?: AgentInput, inputId?: string): AsyncIterable<SessionEvent> {
		const events: SessionEvent[] = [], commands = new Map<string, CommandPresentation>(), edits = new Map<string, BlockEnvelope<"edit">>();
		let wake: (() => void) | undefined, done = false, failure: unknown;
		this.emit = event => { events.push(structuredClone(decorateToolEvent(event, commands, edits))); wake?.(); };
		this.usage.beginTurn(); this.accepting = true;
		this.turnPolicy = this.options.shouldStopAfterTurn ? new TurnPolicy(this.options.shouldStopAfterTurn) : undefined;
		this.preparationFailed = false; this.requestProjection = undefined; this.lastResponse = undefined;
		this.explicitSkillNames.clear();
		this.runController = new AbortController();
		const running = this.runSession(input, this.runController.signal, inputId).then(result => { active.outcome = result; }, error => { failure = error; active.outcome = { status: "error" }; }).finally(() => { done = true; wake?.(); });
		this.running = running;
		try {
			while (!done || events.length) {
				const event = events.shift(); if (event) yield event;
				else await new Promise<void>(resolve => { wake = resolve; });
			}
		} finally {
			if (!done) this.abort();
			await running; this.closeInput();
			this.emit = () => { }; this.running = undefined; this.runController = undefined; this.turnPolicy = undefined; this.requestProjection = undefined;
			this.compaction.syncUsage(); this.usage.endTurn();
			if (failure !== undefined) throw failure;
		}
	}
	steer(input: AgentInput, id: symbol): InputAcceptance { return this.enqueue(input, "steer", id); }
	followUp(input: AgentInput, id: symbol): InputAcceptance { return this.enqueue(input, "followUp", id); }
	private enqueue(input: AgentInput, mode: "steer" | "followUp", id: symbol): InputAcceptance {
		this.assertHealthy();
		if (!this.accepting || !this.active?.begun || this.active.canceled || this.active.id !== id) return { accepted: false };
		const inputId = typeof input === "string" ? undefined : randomUUID(), message = this.inputMessage(input, inputId);
		const processed = new Promise<boolean>(resolve => { this.receipts.set(message, resolve); });
		(mode === "steer" ? this.steering : this.followups).push(message);
		return { accepted: true, processed, ...(inputId ? { inputId } : {}) };
	}
	private drain(queue: SessionMessage[], mode = "all"): SessionMessage[] { return queue.splice(0, mode === "one-at-a-time" ? 1 : queue.length); }
	private async consumeInput(message: SessionMessage, signal: AbortSignal): Promise<void> {
		await this.prepareInputMessage(message, signal); signal.throwIfAborted();
		this.emit({ type: "message_start", message: structuredClone(message), timestamp: Date.now() });
		if (!this.preparedSkills.has(message)) { this.receipts.get(message)?.(true); this.receipts.delete(message); }
		this.stagedMcp.delete(message);
		await this.persistMessage(message);
		if (this.preparedSkills.has(message)) { this.receipts.get(message)?.(true); this.receipts.delete(message); this.preparedSkills.delete(message); }
		this.recoveryUsed = false;
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
					if (!this.skillSources.all) throw new SkillError("skills-disabled", "Skills are disabled");
					if (!this.skills.entries.some(entry => entry.status === "available" && entry.name === invocation.name)) throw new SkillError("unknown-skill", `Unknown skill: ${invocation.name}`);
					const body = explicitSkillBody(await this.skillSources.all.load(invocation.name));
					message.content = [{ type: "text", text: `Skill instructions (${invocation.name}):\n${body}\n\nUser task:\n${invocation.task}` }];
					this.explicitSkillNames.add(invocation.name);
				}
			}
			signal?.throwIfAborted(); this.runController?.signal.throwIfAborted();
			if (this.skills.enabled || selected?.invocation.kind === "mcp_prompt" || selected?.invocation.kind === "mcp_resource") {
				const budget = this.compaction.budget();
				const size = calculateContextUsage({ fixedText: budget.fixedText, messages: projectMessages([message]) }).contextTokens ?? 0;
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
		this.accepting = false; this.steering.length = 0; this.followups.length = 0;
		for (const resolve of this.receipts.values()) resolve(false);
		this.receipts.clear(); this.skillInputs.clear();
	}
	abort(): void {
		if (this.active) this.active.canceled = true;
		this.runController?.abort(); this.compactController?.abort(); this.closeInput();
		const pending = this.pendingApproval; this.pendingApproval = undefined;
		if (pending) { pending.sealed = true; pending.finish(); }
		this.bus.abort();
	}
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
			const history = () => projectMessages(this.messages());
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
		try { await this.storage.append(structuredClone(entry)); }
		catch (error) { this.failure = error; this.abort(); throw error; }
		this.state.entries.push(entry); this.state.leafId = entry.id;
	}
	private async persistMessage(message: SessionMessage): Promise<void> {
		await this.persistEntry(messageEntry(message, this.state.leafId));
		this.requestProjection = undefined; this.compaction.syncUsage();
		if (message.usage) this.usage.recordUsage(message.usage, !this.options.transformContext);
	}
	private async completeResponse(message: SessionMessage, current: ResponseSnapshot): Promise<void> {
		this.lastResponse = message;
		if (!["error", "aborted", "length"].includes(message.stopReason ?? "")) { this.taskFailures = 0; this.recoveryUsed = false; }
		if (this.settings.enabled && this.recoverableLength(message)) message.contextExcluded = true;
		await this.persistMessage(message);
		current.committed = true;
		this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
		if (["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "") || !message.content.some(block => block.type === "tool_call")) await this.completeTurn(current);
	}
	private async commitModelResponse(current: ResponseSnapshot, messages: readonly ModelMessage[]): Promise<void> {
		if (current.committed || this.failure !== undefined) return;
		if (!current.audit) throw new Error("Model response audit is unavailable");
		const message = current.audit.project(messages.slice(current.baseMessageCount), current.nativeUsage);
		if (message.content.some(part => part.type === "tool_call")) await this.prepareResponseTools(message, current);
		await this.completeResponse(message, current);
	}
	private async commitPartialResponse(current: ResponseSnapshot | undefined, error: unknown, signal: AbortSignal): Promise<void> {
		if (!current?.audit || current.committed || this.failure !== undefined) return;
		const reason = signal.aborted || current.audit.reason === "aborted" ? "aborted" : current.audit.reason === "length" || current.audit.reason === "deferred" ? current.audit.reason : "error";
		const detail = reason === "aborted" ? "Request aborted" : reason === "error" ? current.audit.failure ?? (error instanceof Error ? error.message : String(error)) : undefined;
		await this.completeResponse(current.audit.partialMessage(reason, detail), current);
	}
	private async completeTurn(current: ResponseSnapshot): Promise<void> {
		if (current.completed) return;
		current.completed = true;
		const message = this.lastResponse!;
		this.emit({ type: "turn_end", ...(message.stopReason ? { stopReason: message.stopReason } : {}), timestamp: Date.now() });
		this.applyConfigurations();
		if (this.turnPolicy && !["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "")) await this.turnPolicy.evaluate({ message, toolResults: current.toolResults, model: structuredClone(current.options.model), configurationRevision: current.revision }, current.settings.signal);
	}
	private async prepareResponseTools(message: SessionMessage, current: ResponseSnapshot): Promise<void> {
		const history = sessionMessages(this.state);
		for (const call of message.content) {
			if (call.type !== "tool_call" || isProviderExecutedCall(call)) continue;
			const prepared = await prepareToolCall(message, call, current.options, history, current.internalTools, current.settings.signal);
			current.prepared.set(call.id, prepared);
			if (prepared.tool && prepared.decision.kind !== "deny") call.arguments = structuredClone(prepared.args);
		}
	}
	private beginTool(current: ResponseSnapshot, call: ToolCallBlock, args: Record<string, unknown>): void {
		if (current.startedTools.has(call.id)) return;
		current.startedTools.add(call.id);
		this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: structuredClone(args), timestamp: Date.now() });
	}
	private async saveToolResult(current: ResponseSnapshot, call: ToolCallBlock, result: import("@forge-agent/tools").ToolResult<unknown>): Promise<void> {
		if (current.savedResults.has(call.id)) throw new Error(`Tool result already saved: ${call.id}`);
		const prepared = current.prepared.get(call.id);
		this.beginTool(current, call, prepared?.args ?? call.arguments);
		this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content: JSON.stringify(result), isError: result.isError === true, timestamp: Date.now() });
		const message: SessionMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, ...(prepared ? { toolArguments: structuredClone(prepared.args) } : {}), content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() };
		this.emit({ type: "message_start", message: structuredClone(message), timestamp: Date.now() });
		await this.persistMessage(message);
		current.savedResults.add(call.id); current.toolResults.push(message);
		this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
	}
	private async flushPriorDenials(current: ResponseSnapshot, callId: string): Promise<void> {
		for (const call of this.lastResponse?.content ?? []) {
			if (call.type !== "tool_call" || isProviderExecutedCall(call)) continue;
			if (call.id === callId) return;
			if (current.savedResults.has(call.id)) continue;
			const prepared = current.prepared.get(call.id);
			if (prepared?.decision.kind !== "deny") throw new Error(`Native tool execution is out of order: ${call.id}`);
			await this.saveToolResult(current, call, errorResult(prepared.decision.reason));
		}
		throw new Error(`Tool call ${callId} is absent from the current response`);
	}
	private async executeNativeTool(current: ResponseSnapshot, callId: string | undefined, args: unknown, original: boolean): Promise<unknown> {
		const prepared = current.prepared.get(callId ?? "");
		if (!prepared || prepared.decision.kind !== "allow" && prepared.decision.kind !== "ask") throw new Error("Tool approval is not active");
		if (serializePermissionArguments(prepared.args) !== serializePermissionArguments(args as Record<string, unknown>)) throw new Error("Tool arguments differ from the approved values");
		current.settings.signal.throwIfAborted();
		await this.flushPriorDenials(current, prepared.call.id);
		this.beginTool(current, prepared.call, prepared.args);
		const result = await executePreparedTool(prepared, this.lastResponse!, current.options, sessionMessages(this.state), current.settings.signal, this.emit);
		await this.saveToolResult(current, prepared.call, result);
		if (result.isError) throw new Error(result.content.find(part => part.type === "text")?.text ?? "Tool execution failed");
		return original ? result.details : result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	}
	private async resolveApprovalBatch(interrupts: readonly Interrupt[], current: ResponseSnapshot, signal: AbortSignal): Promise<RunAgentResumeItem[]> {
		if (this.pendingApproval) throw new Error("An approval batch is already pending");
		const records = interrupts.map(interrupt => {
			const binding = readInterruptBinding(interrupt);
			if (binding?.kind !== "tool-approval") throw new Error(`Unsupported native interrupt: ${interrupt.id}`);
			const prepared = current.prepared.get(binding.toolCallId);
			if (!prepared || prepared.call.name !== binding.toolName) throw new Error(`Unknown tool approval: ${interrupt.id}`);
			return { interrupt, prepared };
		});
		const answers = new Map<string, RunAgentResumeItem>();
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const pending: PendingApprovalBatch = { requestIds: new Set(), remaining: records.filter(record => record.prepared.decision.kind === "ask").length, sealed: false, finish: release };
		this.pendingApproval = pending;
		const decideAnswer = (id: string, prepared: PreparedToolCall, outcome?: RequestOutcome<"permission">): void => {
			if (pending.sealed || this.pendingApproval !== pending) return;
			let final = prepared;
			let denial: string | undefined;
			try {
				if (outcome?.status === "response") {
					const response = outcome.result;
					if (response.decision === "deny") denial = response.reason ?? "Tool execution denied";
					else {
						if (response.editedArgs !== undefined) final = decideEditedArgs(prepared, response.editedArgs, current.options, current.internalTools);
						if (final.decision.kind === "deny") denial = final.decision.reason;
						else denial = rememberPermission(final, response, current.options.permission);
					}
				} else if (outcome) denial = `Permission request ${outcome.status}: ${outcome.requestId}`;
				else if (final.decision.kind === "deny") denial = final.decision.reason;
			} catch (error) { denial = `Permission decision failed: ${error instanceof Error ? error.message : String(error)}`; }
			current.prepared.set(prepared.call.id, denial ? { ...final, decision: { kind: "deny", source: "hook", reason: denial } } : final);
			answers.set(id, { interruptId: id, status: "resolved", payload: denial ? { approved: false, payload: { reason: denial } } : { approved: true, editedArgs: final.args } });
			if (outcome && --pending.remaining === 0) release();
		};
		try {
			for (const { interrupt, prepared } of records) {
				if (prepared.decision.kind !== "ask") { decideAnswer(interrupt.id, prepared); continue; }
				const id = this.bus.publish("permission", structuredClone(prepared.decision.payload), outcome => decideAnswer(interrupt.id, prepared, outcome), { signal });
				pending.requestIds.add(id);
			}
			if (pending.remaining) await wait;
			signal.throwIfAborted();
			if (answers.size !== records.length) throw new Error("Incomplete native approval batch");
			return records.map(({ interrupt }) => answers.get(interrupt.id)!);
		} finally {
			pending.sealed = true;
			if (this.pendingApproval === pending) this.pendingApproval = undefined;
			for (const id of pending.requestIds) this.bus.cancel(id);
		}
	}
	private async runChat(signal: AbortSignal): Promise<void> {
		this.inChat = true;
		let current!: ResponseSnapshot;
		let engineFailure: unknown;
		let continuation: { messages: ModelMessage[]; parentRunId: string; resume: RunAgentResumeItem[] } | undefined;
		let firstRequest = true;
		const source = this.skillSources.automatic;
		const explicitOnly = new Set(this.skills.entries.filter(entry => entry.status === "available" && entry.disableModelInvocation).map(entry => entry.name));
		const resource = this.skillSources.all ? createResourceTool(filter(this.skillSources.all, skill => !explicitOnly.has(skill.name) || this.explicitSkillNames.has(skill.name))) : undefined;
		const memory = this.options.memory ? { ...this.options.memory } : undefined;
		const latest = selectedBranch(this.state).reverse().find(entry => entry.type === "message" && entry.message.role === "user");
		const provenance = () => ({ kind: "session" as const, timestamp: latest?.timestamp ?? new Date().toISOString(), ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), ...(latest ? { entryId: latest.id } : {}) });
		const memoryAdapter = memory ? new MarkdownMemoryAdapter(memory, { ...this.options }, provenance, () => selectedBranch(this.state).filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError && (!latest || entry.timestamp >= latest.timestamp)).map(entry => JSON.stringify({ tool: entry.message.toolName, content: entry.message.content })).join("\n").slice(0, 4000)) : undefined;
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
					const settle = self.turnPolicy?.beginRequest();
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
					for (const message of this.drain(this.steering, this.options.steeringMode)) await this.consumeInput(message, signal);
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
				const internal = new Set<HarnessTool<object, unknown>>();
				const native = [...nativeTools.values()].map(tool => {
					const schema = convertSchemaToJsonSchema(tool.inputSchema) as JSONSchema;
					if (schema.type !== "object") throw new Error(`Native tool ${tool.name} requires an object schema`);
					const bridged: HarnessTool<object, unknown> = {
						name: tool.name, label: tool.name, description: tool.description, parameters: schema as HarnessTool<object, unknown>["parameters"],
						validateArguments: args => parseWithStandardSchema<object>(tool.inputSchema!, args),
						async execute(args, context) {
							const output = await tool.execute!(args, { ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.signal ? { abortSignal: context.signal } : {}), emitCustomEvent: () => {} });
							return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
						},
					};
					internal.add(bridged);
					return bridged;
				});
				const effectiveTools = [...this.tools, ...native];
				if (new Set(effectiveTools.map(tool => tool.name)).size !== effectiveTools.length) throw new Error("Tool name collision with an internal tool");
				current = {
					options: { ...this.options, tools: effectiveTools }, internalTools: internal, revision: this.appliedRevision, completed: false,
					prepared: new Map(), savedResults: new Set(), startedTools: new Set(), toolResults: [], nativeTools: [], committed: false, baseMessageCount: 0,
					settings: { signal, maxTokens: this.compaction.taskMaxTokens(), ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}), ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), ...(this.options.thinkingLevel !== "off" ? { reasoning: this.options.thinkingLevel } : {}) }
				};
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
				const tools = effectiveTools.map(tool => {
					const original = nativeTools.get(tool.name);
					if (original) return { ...original, needsApproval: true, approvalSchema, execute: (args: unknown, context?: { toolCallId?: string }) => this.executeNativeTool(snapshot, context?.toolCallId, args, true) } as AnyTool;
					// Standard Schema parses before interrupt; preparation must see raw input first.
					const inputSchema = tool.prepareArguments ? tool.parameters : tool.inputSchema ?? tool.parameters;
					return toolDefinition({ name: tool.name, description: tool.description, needsApproval: true, approvalSchema, inputSchema: inputSchema as JSONSchema, outputSchema: { type: "string" } }).server((args, context) => this.executeNativeTool(snapshot, context?.toolCallId, args, false));
				});
				current.nativeTools = tools;
				const messages = toModelMessages(projectMessages(sessionMessages(this.state)));
				current.baseMessageCount = messages.length;
				return { messages, providerMessages: toModelMessages(request.messages), systemPrompts: prompts, tools, modelOptions: providerModelOptions(current.options.model, current.settings) };
			},
			onInterruptBoundary: async ctx => {
				if (ctx.phase === "beforeTools" && current.audit?.hasTools) await this.commitModelResponse(current, ctx.messages);
				return { interrupts: [] };
			},
			onUsage: (_ctx, usage) => { current.nativeUsage = usage; },
			onToolPhaseComplete: async (ctx, info) => {
				if (!current || !this.lastResponse || info.needsApproval.length || signal.aborted || this.failure !== undefined) return;
				for (const call of this.lastResponse.content) {
					if (call.type !== "tool_call" || isProviderExecutedCall(call) || current.savedResults.has(call.id)) continue;
					const prepared = current.prepared.get(call.id);
					const native = info.results.find(result => result.toolCallId === call.id);
					const result = prepared?.decision.kind === "deny" ? errorResult(prepared.decision.reason) : errorResult(native ? JSON.stringify(native.result) : "Tool was not executed");
					await this.saveToolResult(current, call, result);
				}
				await this.completeTurn(current);
				if (this.turnPolicy?.stopped) ctx.abort("forge:policy_stop");
			},
			onShouldContinue: async ctx => {
				// TanStack skips beforeTools and onToolPhaseComplete when every call
				// already has a native error result. Save both sides before its next model request.
				if (current?.audit?.hasTools && !current.committed && !signal.aborted && this.failure === undefined) {
					await this.commitModelResponse(current, ctx.messages);
					for (const call of this.lastResponse?.content ?? []) {
						if (call.type !== "tool_call" || isProviderExecutedCall(call) || current.savedResults.has(call.id)) continue;
						const native = ctx.messages.find(message => message.role === "tool" && message.toolCallId === call.id);
						const detail = native ? typeof native.content === "string" ? native.content : JSON.stringify(native.content) : "Tool was not executed";
						await this.saveToolResult(current, call, errorResult(detail));
					}
					await this.completeTurn(current);
				}
				return !signal.aborted && !this.turnPolicy?.stopped && !this.turnPolicy?.failed && !this.preparationFailed;
			},
			onFinish: async ctx => { if (current?.audit && !current.committed) await this.commitModelResponse(current, ctx.messages); },
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
				const resume = await this.resolveApprovalBatch(interrupts, current, signal);
				continuation = { messages: snapshot, parentRunId: runId, resume };
			}
		} catch (error) { engineFailure = error; }
		finally { linked.dispose(); this.inChat = false; this.applyConfigurations(); }
		if (this.failure !== undefined) throw this.failure;
		if (signal.aborted && current && this.lastResponse?.content.some(part => part.type === "tool_call")) {
			for (const call of this.lastResponse.content) {
				if (call.type === "tool_call" && !isProviderExecutedCall(call) && !current.savedResults.has(call.id)) await this.saveToolResult(current, call, errorResult("Operation aborted"));
			}
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
		const driver = this.driver, policy = this.turnPolicy;
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
		this.taskFailures = 0;
		let retried = false, lastRetryAttempt = 0, outcome: TurnResult = { status: "error" };
		try {
			this.applyConfigurations();
			if (input !== undefined) await this.consumeInput(this.inputMessage(input, inputId), signal);
			else if (!projectMessages(this.messages()).length) throw new Error("Cannot continue: no messages in context");
			while (!signal.aborted) {
				await this.runChat(signal);
				if (signal.aborted || this.preparationFailed || this.turnPolicy?.stopped || this.turnPolicy?.failed) break;
				const message = this.lastResponse;
				if (!message) break;
				const responseDriver = this.responseDriver ?? this.driver;
				const overflow = responseDriver.isOverflow(message), length = this.recoverableLength(message);
				if (this.settings.enabled && ((message.stopReason === "error" && overflow) || length)) {
					if (this.recoveryUsed) break;
					this.recoveryUsed = true;
					const reason = length ? "length" : "overflow";
					this.emit({ type: "recovery", reason, operationId: randomUUID(), attempt: 1, timestamp: Date.now() });
					const result = await this.compaction.run(reason, signal, this.emit);
					if (result.status !== "complete" || signal.aborted) break;
					continue;
				}
				if (message.stopReason === "error" && !overflow && retry.enabled && responseDriver.isRetryable?.(message) && this.taskFailures < retry.maxRetries) {
					const attempt = ++this.taskFailures; retried = true; lastRetryAttempt = attempt;
					const delayMs = retry.baseDelayMs * 2 ** (attempt - 1);
					this.emit({ type: "retry", phase: "scheduled", attempt, delayMs, ...(message.errorMessage ? { error: message.errorMessage } : {}), timestamp: Date.now() });
					await (this.driver.wait ?? waitForRetry)(delayMs, signal); signal.throwIfAborted();
					this.usage.invalidate(); this.compaction.syncUsage();
					this.emit({ type: "retry", phase: "attempt", attempt, timestamp: Date.now() });
					this.applyConfigurations();
					continue;
				}
				if (["error", "aborted", "length", "deferred"].includes(message.stopReason ?? "")) break;
				const steering = this.drain(this.steering, this.options.steeringMode);
				const inputs = steering.length ? steering : this.drain(this.followups, this.options.followUpMode);
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
			const status = this.failure !== undefined ? "error" : signal.aborted ? "aborted" : (this.preparationFailed || this.turnPolicy?.failed) ? "error" : reason === "error" || reason === "aborted" || reason === "length" || reason === "deferred" ? reason : "success";
			outcome = { status, ...(status === "success" && this.turnPolicy?.stopped ? { terminationReason: "policy" as const } : {}) };
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
