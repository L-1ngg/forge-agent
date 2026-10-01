import { readInterruptBinding, type AnyTool, type Interrupt, type ModelMessage, type RunAgentResumeItem, type TokenUsage, type TextOptions, type ToolPhaseCompleteInfo } from "@tanstack/ai";
import type { HarnessTool, ToolResult } from "@forge-agent/tools";
import type { RequestOutcome, SessionEvent, SessionMessage, ToolCallBlock, TokenUsage as SessionTokenUsage } from "@forge-agent/protocol";
import type { SessionConfiguration } from "./configuration.ts";
import type { ModelAdapter, ModelRequestSettings } from "./model-adapter.ts";
import { isProviderExecutedCall, type RawResponseAudit } from "./model-response.ts";
import { prepareToolCall, rememberPermission, executePreparedTool, snapshot, errorResult, type PreparedToolCall } from "./session-tools.ts";
import type { RequestBus } from "./request-bus.ts";
import { cancellable } from "./host-callback.ts";
import { observeModelResponse } from "./model-call.ts";

export interface ResponseBatch {
	message: SessionMessage;
	toolResults: SessionMessage[];
	options: SessionConfiguration;
	revision: number;
	turnComplete: boolean;
	preparationFailed?: boolean;
}

interface ResponseCompletion {
	messages?: readonly ModelMessage[];
	results?: ToolPhaseCompleteInfo["results"];
	error?: unknown;
}

/** A response and its complete native tool batch retain one applied configuration. */
export class SessionResponse {
	private audit: RawResponseAudit | undefined;
	private nativeUsage: TokenUsage | undefined;
	private nativeTools: AnyTool[] = [];
	private baseMessageCount = 0;
	private message: SessionMessage | undefined;
	private settlement: Promise<void> | undefined;
	private prepared = new Map<string, PreparedToolCall>();
	private started = new Set<string>();
	private results = new Map<string, SessionMessage>();
	private approving = false;
	constructor(readonly options: SessionConfiguration, readonly revision: number, readonly settings: ModelRequestSettings,
		private readonly internal: ReadonlySet<HarnessTool<object, unknown>>, private readonly history: () => SessionMessage[],
		private readonly emit: (event: SessionEvent) => void) {}
	get tools(): AnyTool[] { return this.nativeTools; }
	get hasTools(): boolean { return this.audit?.hasTools === true; }
	get needsToolSettlement(): boolean { return this.hasTools && !this.message && !this.settlement; }
	initialize(messages: readonly ModelMessage[], tools: AnyTool[]): void { this.baseMessageCount = messages.length; this.nativeTools = tools; }
	recordUsage(usage: TokenUsage): void { this.nativeUsage = usage; }
	async *observe(adapter: ModelAdapter, request: TextOptions, settle?: (usage?: SessionTokenUsage) => void) {
		try {
			yield* observeModelResponse(adapter, { ...request, model: adapter.model }, this.options, this.emit, audit => {
				this.audit = audit;
				settle?.(audit.usage(this.nativeUsage));
			});
		} finally { settle?.(); }
	}
	private get toolResults(): SessionMessage[] { return (this.message?.content ?? []).flatMap(call => call.type === "tool_call" && this.results.has(call.id) ? [this.results.get(call.id)!] : []); }
	private project(messages: readonly ModelMessage[]): SessionMessage {
		if (!this.audit) throw new Error("Model response audit is unavailable");
		return this.audit.project(messages.slice(this.baseMessageCount), this.nativeUsage);
	}
	async prepare(messages: readonly ModelMessage[], pending: readonly { toolCallId: string; input: unknown }[]): Promise<void> {
		const message = this.project(messages);
		this.message = message;
		const history = this.history();
		for (const item of pending) {
			const call = message.content.find((part): part is ToolCallBlock => part.type === "tool_call" && part.id === item.toolCallId);
			if (!call) throw new Error(`Native approval has no proposal: ${item.toolCallId}`);
			const prepared = await prepareToolCall(message, call, item.input as Record<string, unknown>, this.options, history, this.internal, this.settings.signal);
			this.prepared.set(call.id, prepared);
		}
	}
	/** All native exits share result completion and a once-only batch submission. */
	async finish(commit: (batch: ResponseBatch) => Promise<void>, completion: ResponseCompletion = {}): Promise<void> {
		// The first caller propagates failure. Later native exits only wait for
		// cleanup; the session retains storage faults and the invocation policy outcome.
		if (this.settlement) { await this.settlement.catch(() => {}); return; }
		const { messages, results: nativeResults, error } = completion;
		const completeProposal = this.message !== undefined || messages !== undefined && error === undefined;
		if (!this.message) {
			if (!this.audit) return;
			if (messages && error === undefined) this.message = this.project(messages);
			else if (error !== undefined) {
				const reason = this.settings.signal.aborted || this.audit.reason === "aborted" ? "aborted" : this.audit.reason === "length" || this.audit.reason === "deferred" ? this.audit.reason : "error";
				const detail = reason === "aborted" ? "Request aborted" : reason === "error" ? this.audit.failure ?? (error instanceof Error ? error.message : String(error)) : undefined;
				this.message = this.audit.partialMessage(reason, detail);
			} else return;
		}
		for (const call of this.message.content) {
			if (!completeProposal || call.type !== "tool_call" || isProviderExecutedCall(call) || this.results.has(call.id)) continue;
			const decision = this.prepared.get(call.id)?.decision;
			const native = nativeResults?.find(result => result.toolCallId === call.id);
			const prior = messages?.find(message => message.role === "tool" && message.toolCallId === call.id);
			const detail = decision?.kind === "deny" ? decision.reason : native ? JSON.stringify(native.result) : prior ? typeof prior.content === "string" ? prior.content : JSON.stringify(prior.content) : this.settings.signal.aborted ? "Operation aborted" : error ?? "Tool was not executed";
			this.recordResult(call, errorResult(detail));
		}
		const turnComplete = messages !== undefined && error === undefined || ["error", "aborted", "length", "deferred"].includes(this.message.stopReason ?? "") || !this.message.content.some(part => part.type === "tool_call");
		this.settlement = commit({ message: this.message, toolResults: this.toolResults, options: this.options, revision: this.revision, turnComplete });
		return this.settlement;
	}
	private begin(call: ToolCallBlock, args: Record<string, unknown>): void {
		if (this.started.has(call.id)) return;
		this.started.add(call.id);
		this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: structuredClone(args), timestamp: Date.now() });
	}
	private recordResult(call: ToolCallBlock, result: ToolResult<unknown>, args?: Record<string, unknown>): void {
		if (this.results.has(call.id)) throw new Error(`Tool result already recorded: ${call.id}`);
		const prepared = this.prepared.get(call.id);
		const input = args ?? prepared?.args ?? call.arguments;
		this.begin(call, input);
		this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content: JSON.stringify(result), isError: result.isError === true, timestamp: Date.now() });
		this.results.set(call.id, { role: "toolResult", toolCallId: call.id, toolName: call.name, toolArguments: structuredClone(input), content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() });
	}
	async execute(callId: string | undefined, args: unknown, original: boolean): Promise<unknown> {
		if (!this.message) throw new Error("Tool proposal is unavailable");
		const prepared = this.prepared.get(callId ?? "");
		if (!prepared || prepared.decision.kind !== "allow" && prepared.decision.kind !== "ask") throw new Error("Tool approval is not active");
		this.settings.signal.throwIfAborted();
		const input = snapshot(args as Record<string, unknown>);
		this.begin(prepared.call, input);
		const result = await executePreparedTool({ ...prepared, args: input }, this.message, this.options, this.history(), this.settings.signal, this.emit);
		this.recordResult(prepared.call, result, input);
		if (result.isError) throw new Error(result.content.find(part => part.type === "text")?.text ?? "Tool execution failed");
		return original ? result.details : result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	}
	async approve(interrupts: readonly Interrupt[], bus: RequestBus): Promise<RunAgentResumeItem[]> {
		if (this.approving) throw new Error("An approval batch is already pending");
		if (!this.message) throw new Error("Tool proposal is unavailable");
		const records = interrupts.map(interrupt => {
			const binding = readInterruptBinding(interrupt);
			if (binding?.kind !== "tool-approval") throw new Error(`Unsupported native interrupt: ${interrupt.id}`);
			const prepared = this.prepared.get(binding.toolCallId);
			if (!prepared || prepared.call.name !== binding.toolName) throw new Error(`Unknown tool approval: ${interrupt.id}`);
			return { interrupt, prepared };
		});
		this.approving = true;
		const answers = new Map<string, RunAgentResumeItem>(), requestIds = new Set<string>();
		let remaining = records.filter(record => record.prepared.decision.kind === "ask").length, sealed = false;
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const decide = (id: string, prepared: PreparedToolCall, outcome?: RequestOutcome<"permission">): void => {
			if (sealed) return;
			let editedArgs: Record<string, unknown> | undefined, denial: string | undefined;
			try {
				if (outcome?.status === "response") {
					const response = outcome.result;
					if (response.decision === "deny") denial = response.reason ?? "Tool execution denied";
					else {
						editedArgs = response.editedArgs;
						denial = rememberPermission(prepared, response, this.options.permission);
					}
				} else if (outcome) denial = `Permission request ${outcome.status}: ${outcome.requestId}`;
				else if (prepared.decision.kind === "deny") denial = prepared.decision.reason;
			} catch (error) { denial = `Permission decision failed: ${error instanceof Error ? error.message : String(error)}`; }
			if (denial) this.prepared.set(prepared.call.id, { ...prepared, decision: { kind: "deny", source: "hook", reason: denial } });
			answers.set(id, { interruptId: id, status: "resolved", payload: denial ? { approved: false, payload: { reason: denial } } : { approved: true, ...(editedArgs !== undefined ? { editedArgs } : {}) } });
			if (outcome && --remaining === 0) release();
		};
		try {
			for (const { interrupt, prepared } of records) {
				if (prepared.decision.kind !== "ask") { decide(interrupt.id, prepared); continue; }
				requestIds.add(bus.publish("permission", structuredClone(prepared.decision.payload), outcome => decide(interrupt.id, prepared, outcome), { signal: this.settings.signal }));
			}
			if (remaining) await cancellable(() => wait, this.settings.signal);
			this.settings.signal.throwIfAborted();
			if (answers.size !== records.length) throw new Error("Incomplete native approval batch");
			return records.map(({ interrupt }) => answers.get(interrupt.id)!);
		} finally {
			sealed = true; this.approving = false;
			for (const id of requestIds) bus.cancel(id);
		}
	}
}
