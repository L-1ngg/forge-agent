import { readInterruptBinding, type AnyTool, type Interrupt, type ModelMessage, type RunAgentResumeItem, type TokenUsage } from "@tanstack/ai";
import type { HarnessTool, ToolResult } from "@forge-agent/tools";
import { serializePermissionArguments, type RequestOutcome, type SessionEvent, type SessionMessage, type ToolCallBlock } from "@forge-agent/protocol";
import type { SessionConfiguration } from "./configuration.ts";
import type { ModelRequestSettings } from "./model-adapter.ts";
import { isProviderExecutedCall, type RawResponseAudit } from "./model-response.ts";
import { prepareToolCall, decideEditedArgs, rememberPermission, executePreparedTool, errorResult, type PreparedToolCall } from "./session-tools.ts";
import type { RequestBus } from "./request-bus.ts";
import { cancellable } from "./host-callback.ts";

/** A response and its complete native tool batch retain one applied configuration. */
export class SessionResponse {
	audit: RawResponseAudit | undefined;
	nativeUsage: TokenUsage | undefined;
	nativeTools: AnyTool[] = [];
	baseMessageCount = 0;
	private message: SessionMessage | undefined;
	private completed = false;
	private prepared = new Map<string, PreparedToolCall>();
	private saved = new Set<string>();
	private started = new Set<string>();
	private results: SessionMessage[] = [];
	private approving = false;
	constructor(readonly options: SessionConfiguration, readonly revision: number, readonly settings: ModelRequestSettings,
		private readonly internal: ReadonlySet<HarnessTool<object, unknown>>, private readonly history: () => SessionMessage[],
		private readonly persist: (message: SessionMessage) => Promise<void>, private readonly emit: (event: SessionEvent) => void) {}
	get committed(): boolean { return this.message !== undefined; }
	get toolResults(): SessionMessage[] { return this.results; }
	project(messages: readonly ModelMessage[]): SessionMessage {
		if (!this.audit) throw new Error("Model response audit is unavailable");
		return this.audit.project(messages.slice(this.baseMessageCount), this.nativeUsage);
	}
	async prepare(message: SessionMessage): Promise<void> {
		const history = this.history();
		for (const call of message.content) {
			if (call.type !== "tool_call" || isProviderExecutedCall(call)) continue;
			const prepared = await prepareToolCall(message, call, this.options, history, this.internal, this.settings.signal);
			this.prepared.set(call.id, prepared);
			if (prepared.tool && prepared.decision.kind !== "deny") call.arguments = structuredClone(prepared.args);
		}
	}
	commit(message: SessionMessage): void { if (this.committed) throw new Error("Response already committed"); this.message = message; }
	complete(): boolean { if (this.completed) return false; this.completed = true; return true; }
	unsavedCalls(): ToolCallBlock[] { return (this.message?.content ?? []).filter((call): call is ToolCallBlock => call.type === "tool_call" && !isProviderExecutedCall(call) && !this.saved.has(call.id)); }
	denial(callId: string): string | undefined { const decision = this.prepared.get(callId)?.decision; return decision?.kind === "deny" ? decision.reason : undefined; }
	private begin(call: ToolCallBlock, args: Record<string, unknown>): void {
		if (this.started.has(call.id)) return;
		this.started.add(call.id);
		this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: structuredClone(args), timestamp: Date.now() });
	}
	async saveResult(call: ToolCallBlock, result: ToolResult<unknown>): Promise<void> {
		if (this.saved.has(call.id)) throw new Error(`Tool result already saved: ${call.id}`);
		const prepared = this.prepared.get(call.id);
		this.begin(call, prepared?.args ?? call.arguments);
		this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content: JSON.stringify(result), isError: result.isError === true, timestamp: Date.now() });
		const message: SessionMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, ...(prepared ? { toolArguments: structuredClone(prepared.args) } : {}), content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() };
		this.emit({ type: "message_start", message: structuredClone(message), timestamp: Date.now() });
		await this.persist(message);
		this.saved.add(call.id); this.results.push(message);
		this.emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
	}
	private async flushPriorDenials(callId: string): Promise<void> {
		for (const call of this.unsavedCalls()) {
			if (call.id === callId) return;
			const denial = this.denial(call.id);
			if (denial === undefined) throw new Error(`Native tool execution is out of order: ${call.id}`);
			await this.saveResult(call, errorResult(denial));
		}
		throw new Error(`Tool call ${callId} is absent from the current response`);
	}
	async execute(callId: string | undefined, args: unknown, original: boolean): Promise<unknown> {
		if (!this.message) throw new Error("Tool proposal is not committed");
		const prepared = this.prepared.get(callId ?? "");
		if (!prepared || prepared.decision.kind !== "allow" && prepared.decision.kind !== "ask") throw new Error("Tool approval is not active");
		if (serializePermissionArguments(prepared.args) !== serializePermissionArguments(args as Record<string, unknown>)) throw new Error("Tool arguments differ from the approved values");
		this.settings.signal.throwIfAborted();
		await this.flushPriorDenials(prepared.call.id);
		this.begin(prepared.call, prepared.args);
		const result = await executePreparedTool(prepared, this.message, this.options, this.history(), this.settings.signal, this.emit);
		await this.saveResult(prepared.call, result);
		if (result.isError) throw new Error(result.content.find(part => part.type === "text")?.text ?? "Tool execution failed");
		return original ? result.details : result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	}
	async approve(interrupts: readonly Interrupt[], bus: RequestBus): Promise<RunAgentResumeItem[]> {
		if (this.approving) throw new Error("An approval batch is already pending");
		if (!this.message) throw new Error("Tool proposal is not committed");
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
			let final = prepared, denial: string | undefined;
			try {
				if (outcome?.status === "response") {
					const response = outcome.result;
					if (response.decision === "deny") denial = response.reason ?? "Tool execution denied";
					else {
						if (response.editedArgs !== undefined) final = decideEditedArgs(prepared, response.editedArgs, this.options, this.internal);
						denial = final.decision.kind === "deny" ? final.decision.reason : rememberPermission(final, response, this.options.permission);
					}
				} else if (outcome) denial = `Permission request ${outcome.status}: ${outcome.requestId}`;
				else if (final.decision.kind === "deny") denial = final.decision.reason;
			} catch (error) { denial = `Permission decision failed: ${error instanceof Error ? error.message : String(error)}`; }
			this.prepared.set(prepared.call.id, denial ? { ...final, decision: { kind: "deny", source: "hook", reason: denial } } : final);
			answers.set(id, { interruptId: id, status: "resolved", payload: denial ? { approved: false, payload: { reason: denial } } : { approved: true, editedArgs: final.args } });
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
			// Parameter revisions are append-only evidence, not a replayable approval ledger.
			// Commit every edit before resuming, including edits later in the serial batch.
			for (const { prepared } of records) {
				const final = this.prepared.get(prepared.call.id)!;
				if (final.decision.kind === "deny" || serializePermissionArguments(prepared.args) === serializePermissionArguments(final.args)) continue;
				await this.persist({ role: "assistant", content: [], timestamp: Date.now(), contextExcluded: true, toolCallId: final.call.id, toolName: final.call.name, toolArguments: structuredClone(final.args) });
				this.settings.signal.throwIfAborted();
			}
			return records.map(({ interrupt }) => answers.get(interrupt.id)!);
		} finally {
			sealed = true; this.approving = false;
			for (const id of requestIds) bus.cancel(id);
		}
	}
}
