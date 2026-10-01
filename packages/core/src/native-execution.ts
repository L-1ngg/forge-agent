import { chat, type ChatMiddleware, type TextOptions, type AnyTool, type Interrupt, type ModelMessage, type RunAgentResumeItem } from "@tanstack/ai";
import { createResourceTool, filter, withSkills } from "@tanstack/ai-skills";
import { memoryMiddleware } from "@tanstack/ai-memory";
import type { HarnessTool } from "@forge-agent/tools";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import type { SessionConfiguration } from "./configuration.ts";
import { resolveProviderAdapter, providerModelOptions, type ModelAdapter, type ModelRequestSettings } from "./model-adapter.ts";
import { toModelMessages } from "./model-response.ts";
import { linkedController } from "./model-call.ts";
import { bridgeSessionTools } from "./session-tools.ts";
import type { PreparedSkills } from "./skills/source.ts";
import type { MessageEntry } from "./session-storage.ts";
import { createMemoryTools } from "./memory/tools.ts";
import { MarkdownMemoryAdapter } from "./memory/adapter.ts";
import { SessionResponse, type ResponseBatch } from "./session-response.ts";
import { sessionOtel } from "./session-otel.ts";
import type { RequestBus } from "./request-bus.ts";
import type { TurnPolicy } from "./turn-policy.ts";
export type { ResponseBatch } from "./session-response.ts";

export interface NativeRequest {
	options: SessionConfiguration;
	revision: number;
	settings: ModelRequestSettings;
	tools: HarnessTool<object, unknown>[];
}

/** Session operations, not access to its mutable execution state. */
export interface NativeExecutionHost {
	prepareRequest(initial: boolean): Promise<NativeRequest>;
	projectRequest(systemPrompt: string, tools: HarnessTool<object, unknown>[]): Promise<{ messages: SessionMessage[]; history: SessionMessage[] }>;
	commit(batch: ResponseBatch): Promise<void>;
	history(): { messages: SessionMessage[]; entries: readonly MessageEntry[] };
	fault(): unknown;
	release(): Pick<NativeRequest, "options" | "revision">;
}

export interface NativeExecutionInput {
	options: SessionConfiguration;
	revision: number;
	skills: PreparedSkills;
	explicitSkillNames: ReadonlySet<string>;
	history: readonly MessageEntry[];
	messages: SessionMessage[];
	bus: RequestBus;
	policy: TurnPolicy | undefined;
	signal: AbortSignal;
	emit(event: SessionEvent): void;
}

/** Native chat owns tool continuation; this module owns its response lifecycle. */
export async function runNativeExecution(host: NativeExecutionHost, input: NativeExecutionInput): Promise<void> {
	const { options, skills, signal, emit, policy } = input;
	let current: SessionResponse | undefined;
	let requestSnapshot: NativeRequest | undefined;
	let failureConfiguration: Pick<NativeRequest, "options" | "revision"> = input;
	let lastResponse: SessionMessage | undefined;
	let engineFailure: unknown;
	let continuation: { messages: ModelMessage[]; parentRunId: string; resume: RunAgentResumeItem[] } | undefined;
	let firstRequest = true;
	const explicitOnly = new Set(skills.snapshot.entries.filter(entry => entry.status === "available" && entry.disableModelInvocation).map(entry => entry.name));
	const resource = skills.all ? createResourceTool(filter(skills.all, skill => !explicitOnly.has(skill.name) || input.explicitSkillNames.has(skill.name))) : undefined;
	const memory = options.memory ? { ...options.memory } : undefined;
	const latest = [...input.history].reverse().find(entry => entry.message.role === "user");
	const provenance = () => ({ kind: "session" as const, timestamp: latest?.timestamp ?? new Date().toISOString(), ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(latest ? { entryId: latest.id } : {}) });
	const memoryAdapter = memory ? new MarkdownMemoryAdapter(memory, { ...options }, provenance, () => host.history().entries.filter(entry => entry.message.role === "toolResult" && !entry.message.isError && (!latest || entry.timestamp >= latest.timestamp)).map(entry => JSON.stringify({ tool: entry.message.toolName, content: entry.message.content })).join("\n").slice(0, 4000), signal) : undefined;
	const memoryTools = memory ? createMemoryTools(memory.store, provenance) : [];
	const nativeTools = new Map<string, AnyTool>();
	if (resource) nativeTools.set(resource.name, resource);
	for (const tool of memoryTools) nativeTools.set(tool.name, tool);
	let forgePrompt: string | undefined;
	const commit = async (batch: ResponseBatch) => { lastResponse = batch.message; await host.commit(batch); };
	const commitFailure = async (reason: "error" | "aborted", error: unknown) => {
		const batch = failureBatch(failureConfiguration, reason, error);
		if (reason === "error" && !lastResponse) batch.preparationFailed = true;
		emit({ type: "message_start", message: batch.message, timestamp: Date.now() });
		await commit(batch);
	};
	const routed: ModelAdapter = {
		kind: "text", name: "forge", model: options.model.id, "~types": undefined!,
		chatStream: (request: TextOptions) => {
			const snapshot = current!;
			return (async function*() {
				snapshot.settings.signal.throwIfAborted();
				const adapter = snapshot.options.adapter ?? await resolveProviderAdapter(snapshot.options.model, snapshot.settings);
				yield* snapshot.observe(adapter, request, policy?.beginRequest());
			})();
		},
		structuredOutput: async () => { throw new Error("Task execution does not use separate structured finalization"); },
	};
	const middleware: ChatMiddleware = {
		name: "forge-session",
		onConfig: async (ctx, config) => {
			if (ctx.phase === "init" && continuation) return { tools: current!.tools };
			if (ctx.phase !== "beforeModel") return;
			signal.throwIfAborted(); lastResponse = undefined;
			const snapshot = await host.prepareRequest(firstRequest);
			requestSnapshot = snapshot;
			const baseNames = new Set(snapshot.tools.map(tool => tool.name));
			for (const tool of config.tools) {
				if (baseNames.has(tool.name) && !nativeTools.has(tool.name)) {
					if (firstRequest) throw new Error(`Tool name collision: ${tool.name}`);
					continue;
				}
				if (!nativeTools.has(tool.name)) nativeTools.set(tool.name, tool);
			}
			firstRequest = false;
			const bridge = bridgeSessionTools(snapshot.tools, nativeTools);
			current = new SessionResponse({ ...snapshot.options, tools: bridge.effective }, snapshot.revision, snapshot.settings, bridge.internal, () => host.history().messages, emit);
			emit({ type: "turn_start", timestamp: Date.now() });
			const prompts = [...config.systemPrompts.filter(prompt => (typeof prompt === "string" ? prompt : prompt.content) !== forgePrompt), { content: current.options.systemPrompt }];
			forgePrompt = current.options.systemPrompt;
			const systemPrompt = prompts.map(prompt => typeof prompt === "string" ? prompt : prompt.content).join("\n\n");
			const projection = await host.projectRequest(systemPrompt, bridge.effective);
			signal.throwIfAborted();
			const response = current;
			const tools = bridge.bind((callId, args, original) => response.execute(callId, args, original));
			const messages = toModelMessages(projection.history);
			current.initialize(messages, tools);
			return { messages, providerMessages: toModelMessages(projection.messages), systemPrompts: prompts, tools, modelOptions: providerModelOptions(current.options.model, current.settings) };
		},
		onUsage: (_ctx, usage) => { current?.recordUsage(usage); },
		onToolPhaseComplete: async (ctx, info) => {
			if (!current || signal.aborted || host.fault() !== undefined) return;
			if (info.needsApproval.length) { await current.prepare(ctx.messages, info.needsApproval); return; }
			await current.finish(commit, { messages: ctx.messages, results: info.results });
			if (policy?.stopped) ctx.abort("forge:policy_stop");
		},
		onShouldContinue: async ctx => {
			// Native output-error batches skip the tool phase. The same settlement
			// completes their history before TanStack starts another model request.
			if (current?.needsToolSettlement && !signal.aborted && host.fault() === undefined) await current.finish(commit, { messages: ctx.messages });
			return !signal.aborted && !policy?.stopped && !policy?.failed;
		},
		onFinish: async ctx => { if (current && !current.hasTools && host.fault() === undefined) await current.finish(commit, { messages: ctx.messages }); },
		onError: async (_ctx, info) => { engineFailure = info.error; if (host.fault() === undefined) await current?.finish(commit, { error: info.error }); },
		onAbort: async () => { if (host.fault() === undefined) await current?.finish(commit, { error: new Error("Request aborted") }); },
	};
	const linked = linkedController(signal);
	try {
		// Native logging must not duplicate domain errors on CLI JSON stdout.
		const nativeMemory = memoryAdapter ? memoryMiddleware({
			adapter: memoryAdapter, scope: { threadId: options.sessionId ?? "session" }, role: memory?.injection === false ? "save-only" : "recall+save",
			onRecall: ({ result }) => emit({ type: "memory", phase: "recall", selected: result.fragments?.map(fragment => fragment.source) ?? [], timestamp: Date.now() }),
			onSave: ({ receipts }) => emit({ type: "memory", phase: "save", status: receipts.some(receipt => !receipt.ok) ? "failed" : receipts.length ? "saved" : "skipped", calls: memoryAdapter.organizerCalls, ...(memoryAdapter.organizerUsage ? { usage: memoryAdapter.organizerUsage } : {}), receipts: receipts.map(receipt => ({ ok: receipt.ok, ...(receipt.error ? { error: receipt.error } : {}), ...(receipt.raw ? { raw: receipt.raw } : {}) })), timestamp: Date.now() }),
		}) : undefined;
		const otel = options.otel ? sessionOtel(options.otel, () => {
			const configuration = current?.options ?? requestSnapshot?.options ?? options;
			return { provider: configuration.adapter?.name ?? configuration.model.provider, model: configuration.adapter?.model ?? configuration.model.id, revision: current?.revision ?? requestSnapshot?.revision ?? input.revision };
		}) : undefined;
		const middlewareChain = [...(nativeMemory ? [nativeMemory] : []), ...(skills.automatic ? [withSkills(skills.automatic)] : []), middleware, ...(otel ? [otel] : [])];
		const threadId = options.sessionId ?? randomUUID();
		while (!signal.aborted) {
			const runId = randomUUID();
			let snapshot: ModelMessage[] | undefined;
			let interrupts: readonly Interrupt[] | undefined;
			for await (const chunk of chat({
				adapter: routed, messages: continuation?.messages ?? toModelMessages(input.messages), threadId, runId,
				...(continuation ? { parentRunId: continuation.parentRunId, resume: continuation.resume } : {}),
				abortController: linked.controller, tools: continuation ? current!.tools : [...(resource ? [resource] : []), ...memoryTools],
				middleware: middlewareChain, agentLoopStrategy: () => true, debug: false,
			})) {
				if (chunk.type === "MESSAGES_SNAPSHOT") snapshot = chunk.messages as unknown as ModelMessage[];
				if (chunk.type === "RUN_FINISHED" && chunk.outcome?.type === "interrupt") interrupts = chunk.outcome.interrupts;
			}
			if (!interrupts) break;
			if (!snapshot) throw new Error("Native interrupt has no messages snapshot");
			const resume = await current!.approve(interrupts, input.bus);
			continuation = { messages: snapshot, parentRunId: runId, resume };
		}
	} catch (error) { engineFailure = error; }
	finally { linked.dispose(); failureConfiguration = host.release(); }
	if (host.fault() !== undefined) throw host.fault();
	await current?.finish(commit, { error: signal.aborted ? new Error("Operation aborted") : engineFailure });
	if (signal.aborted && lastResponse?.stopReason !== "aborted" && (!lastResponse || lastResponse.content.some(part => part.type === "tool_call"))) {
		await commitFailure("aborted", signal.reason ?? new Error("Request aborted"));
	} else if (engineFailure !== undefined && (!lastResponse || !["error", "aborted", "length", "deferred"].includes(lastResponse.stopReason ?? ""))) {
		await commitFailure("error", engineFailure);
	}
}

function failureBatch(configuration: Pick<NativeRequest, "options" | "revision">, reason: "error" | "aborted", error: unknown): ResponseBatch {
	const { options, revision } = configuration;
	return { message: { role: "assistant", content: [], timestamp: Date.now(), provider: options.model.provider, model: options.model.id, api: options.model.api, stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error) }, toolResults: [], options, revision, turnComplete: true };
}
