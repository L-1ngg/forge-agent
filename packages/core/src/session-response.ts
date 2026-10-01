import { readInterruptBinding, type AnyTool, type Interrupt, type ModelMessage, type RunAgentResumeItem, type TokenUsage } from "@tanstack/ai";
import type { HarnessTool, ToolResult } from "@forge-agent/tools";
import type { RequestOutcome, SessionEvent, SessionMessage, ToolCallBlock } from "@forge-agent/protocol";
import type { SessionConfiguration } from "./configuration.ts";
import type { ModelRequestSettings } from "./model-adapter.ts";
import { isProviderExecutedCall, type RawResponseAudit } from "./model-response.ts";
import { prepareToolCall, rememberPermission, executePreparedTool, snapshot, type PreparedToolCall } from "./session-tools.ts";
import type { RequestBus } from "./request-bus.ts";
import { cancellable } from "./host-callback.ts";

/** A response and its complete native tool batch retain one applied configuration. */
export class SessionResponse {
	audit: RawResponseAudit | undefined;
	nativeUsage: TokenUsage | undefined;
	nativeTools: AnyTool[] = [];
	baseMessageCount = 0;
	message: SessionMessage | undefined;
	committed = false;
	private completed = false;
	private prepared = new Map<string, PreparedToolCall>();
	private started = new Set<string>();
	private results = new Map<string, SessionMessage>();
	private approving = false;
	constructor(readonly options: SessionConfiguration, readonly revision: number, readonly settings: ModelRequestSettings,
		private readonly internal: ReadonlySet<HarnessTool<object, unknown>>, private readonly history: () => SessionMessage[],
		private readonly persist: (message: SessionMessage) => Promise<void>, private readonly emit: (event: SessionEvent) => void) {}
	get toolResults(): SessionMessage[] { return (this.message?.content ?? []).flatMap(call => call.type === "tool_call" && this.results.has(call.id) ? [this.results.get(call.id)!] : []); }
	project(messages: readonly ModelMessage[]): SessionMessage {
		if (!this.audit) throw new Error("Model response audit is unavailable");
		return this.audit.project(messages.slice(this.baseMessageCount), this.nativeUsage);
	}
	async prepare(message: SessionMessage, pending: readonly { toolCallId: string; input: unknown }[]): Promise<void> {
		this.message = message;
		const history = this.history();
		for (const item of pending) {
			const call = message.content.find((part): part is ToolCallBlock => part.type === "tool_call" && part.id === item.toolCallId);
			if (!call) throw new Error(`Native approval has no proposal: ${item.toolCallId}`);
			const prepared = await prepareToolCall(message, call, item.input as Record<string, unknown>, this.options, history, this.internal, this.settings.signal);
			this.prepared.set(call.id, prepared);
		}
	}
	commit(message: SessionMessage): void { if (this.committed) throw new Error("Response already committed"); this.message = message; this.committed = true; }
	complete(): boolean { if (this.completed) return false; this.completed = true; return true; }
	pendingResults(): ToolCallBlock[] { return (this.message?.content ?? []).filter((call): call is ToolCallBlock => call.type === "tool_call" && !isProviderExecutedCall(call) && !this.results.has(call.id)); }
	denial(callId: string): string | undefined { const decision = this.prepared.get(callId)?.decision; return decision?.kind === "deny" ? decision.reason : undefined; }
	private begin(call: ToolCallBlock, args: Record<string, unknown>): void {
		if (this.started.has(call.id)) return;
		this.started.add(call.id);
		this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: structuredClone(args), timestamp: Date.now() });
	}
	recordResult(call: ToolCallBlock, result: ToolResult<unknown>, args?: Record<string, unknown>): void {
		if (this.results.has(call.id)) throw new Error(`Tool result already recorded: ${call.id}`);
		const prepared = this.prepared.get(call.id);
		const input = args ?? prepared?.args ?? call.arguments;
		this.begin(call, input);
		this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content: JSON.stringify(result), isError: result.isError === true, timestamp: Date.now() });
		this.results.set(call.id, { role: "toolResult", toolCallId: call.id, toolName: call.name, toolArguments: structuredClone(input), content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() });
	}
	async persistResults(): Promise<void> {
		for (const message of this.toolResults) {
			this.emit({ type: "message_start", message: structuredClone(message), timestamp: Date.now() });
			await this.persist(message);
			this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
		}
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
