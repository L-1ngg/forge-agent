import { permissionScopeForToolCall, type ToolCallBlock, type SessionMessage, type SessionEvent } from "@forge-agent/protocol";
import type { HarnessTool, ToolResult } from "@forge-agent/tools";
import type { SessionConfiguration } from "./configuration.ts";
import { decide, formatPermissionRule, type PermissionContext } from "./permission/index.ts";
import { permissionResultFromOutcome, type RequestBus } from "./request-bus.ts";
import { MEMORY_TOOL_NAMES } from "./memory/tools.ts";
import { validateToolArguments } from "./tool-arguments.ts";
import { freeze } from "./host-callback.ts";

export interface ToolCallContext {
	assistantMessage: SessionMessage;
	toolCall: ToolCallBlock;
	args: Record<string, unknown>;
	context: { systemPrompt: string; messages: SessionMessage[]; tools: Array<HarnessTool<object, unknown>>; };
}
export interface BeforeToolCallResult { block: boolean; reason?: string; terminate?: boolean; }
export interface AfterToolCallContext extends ToolCallContext { result: ToolResult<unknown>; isError: boolean; }
export type AfterToolCallResult = Partial<ToolResult<unknown>>;
export interface ToolHooks {
	toolExecution?: "parallel" | "sequential";
	beforeToolCall?: (context: ToolCallContext, signal?: AbortSignal) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
}
export interface ToolBatch { messages: SessionMessage[]; results: Map<string, ToolResult<unknown>>; terminate: boolean; }

export function validateSessionTools(options: Pick<SessionConfiguration, "tools" | "memory">): void {
	if (options.memory && options.tools?.some(tool => MEMORY_TOOL_NAMES.includes(tool.name))) throw new Error("Memory tool names are reserved when memory is configured");
	if (options.tools?.some(tool => ["read_context", "search_context"].includes(tool.name))) throw new Error("read_context and search_context are reserved by context compaction");
}

interface PermissionHookOptions { context: PermissionContext; requestBus?: RequestBus; }

function makeToolCall(id: string, name: string, argumentsValue: unknown): ToolCallBlock {
	return { type: "tool_call", id, name, arguments: argumentsValue as Record<string, unknown> };
}

interface PermissionCheckAllowed {
	allowed: true;
}

interface PermissionCheckDenied {
	allowed: false;
	reason: string;
}

type PermissionCheck = PermissionCheckAllowed | PermissionCheckDenied;

export async function checkPermission(toolCall: ToolCallBlock, options: PermissionHookOptions, signal?: AbortSignal): Promise<PermissionCheck> {
	// Permission hooks observe the final values, but cannot mutate the argument
	// object held by the executor or a later rule in the same decision.
	toolCall = freeze(structuredClone(toolCall));
	const decision = decide(toolCall, options.context);
	if (decision.kind === "allow") return { allowed: true };
	if (decision.kind === "deny") return { allowed: false, reason: decision.reason };
	if (!options.requestBus) return { allowed: false, reason: "Interactive permission request is unavailable" };

	const outcome = await options.requestBus.ask("permission", structuredClone(decision.payload), signal ? { signal } : {});
	const result = permissionResultFromOutcome(outcome);
	if (result.decision === "allow_once") return { allowed: true };
	if (result.decision === "allow_always") {
		const expectedScope = permissionScopeForToolCall(toolCall);
		if (!decision.payload.rememberRule || !options.context.memory || decision.payload.rememberRule !== formatPermissionRule(expectedScope)) {
			return { allowed: false, reason: "Always allow is unavailable for this tool call" };
		}
		if (result.scope.tool !== expectedScope.tool || result.scope.argsPattern !== expectedScope.argsPattern) {
			return { allowed: false, reason: "Permission scope differs from the rule shown for this tool call" };
		}
		options.context.memory.remember(result.scope);
		return { allowed: true };
	}
	return { allowed: false, reason: result.reason ?? "Tool execution denied" };
}

type Prepared = { call: ToolCallBlock; tool: HarnessTool<object, unknown>; args: Record<string, unknown>; };
const errorResult = (error: unknown, terminate = false): ToolResult<unknown> => ({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true, ...(terminate ? { terminate: true } : {}) });
function snapshot<T>(value: T): T { JSON.stringify(value); return structuredClone(value); }

/** The only tool policy/execution path. TanStack owns continuation, this batch owns effects. */
export async function executeToolBatch(
	message: SessionMessage, options: SessionConfiguration, messages: SessionMessage[], signal: AbortSignal,
	emit: (event: SessionEvent) => void, persist: (message: SessionMessage) => Promise<void>,
	internalTools: ReadonlySet<HarnessTool<object, unknown>> = new Set(),
): Promise<ToolBatch> {
	const calls = message.content.filter((part): part is ToolCallBlock => part.type === "tool_call");
	const tools = options.tools ?? [];
	const hookContext = (call: ToolCallBlock, args: Record<string, unknown>): ToolCallContext => ({
		assistantMessage: structuredClone(message), toolCall: structuredClone(call), args,
		context: { systemPrompt: options.systemPrompt, messages: structuredClone(messages), tools: tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) },
	});
	const results = new Map<string, ToolResult<unknown>>();
	const savedMessages: SessionMessage[] = [];
	const begin = (call: ToolCallBlock) => emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: structuredClone(call.arguments), timestamp: Date.now() });
	const end = (call: ToolCallBlock, result: ToolResult<unknown>) => emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, content: JSON.stringify(result), isError: result.isError === true, timestamp: Date.now() });
	const prepare = async (call: ToolCallBlock): Promise<Prepared | ToolResult<unknown>> => {
		try {
			signal.throwIfAborted();
			const tool = tools.find(tool => tool.name === call.name);
			if (!tool) return errorResult(`Tool ${call.name} not found`);
			let args = validateToolArguments(tool, tool.prepareArguments ? tool.prepareArguments(structuredClone(call.arguments)) : structuredClone(call.arguments));
			const rewrite = options.toolInputRewrites?.[call.name];
			if (rewrite) args = validateToolArguments(tool, await rewrite(args, { cwd: options.cwd, toolCallId: call.id, signal }));
			const decision = await options.toolHooks?.beforeToolCall?.(hookContext(call, args), signal);
			if (decision?.block) return errorResult(decision.reason ?? "Tool execution was blocked", decision.terminate);
			signal.throwIfAborted();
			args = snapshot(validateToolArguments(tool, args));
			const check = internalTools.has(tool) ? { allowed: true as const } : await checkPermission(makeToolCall(call.id, call.name, args), { context: options.permission ?? {}, ...(options.requestBus ? { requestBus: options.requestBus } : {}) }, signal);
			if (!check.allowed) return errorResult(call.name === "load_skill" ? JSON.stringify({ code: "permission-denied", message: check.reason }) : check.reason, true);
			signal.throwIfAborted();
			return { call, tool, args };
		} catch (error) { return errorResult(error); }
	};
	const execute = async (prepared: Prepared): Promise<ToolResult<unknown>> => {
		const { call, tool, args } = prepared;
		if (signal.aborted) return errorResult("Operation aborted");
		let result: ToolResult<unknown>;
		let accepting = true;
		try {
			result = snapshot(await tool.execute(args, {
				cwd: options.cwd, toolCallId: call.id, signal, onUpdate: update => {
					if (accepting) emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, content: JSON.stringify(snapshot(update)), timestamp: Date.now() });
				}
			}));
			if (call.name.startsWith("mcp_") && !options.model.input.includes("image")) result.content = result.content.map(part => part.type === "image" ? { type: "text", text: "This model does not support image input. Original MCP image bytes remain available in the attachment references." } : part);
		} catch (error) { result = errorResult(error); }
		finally { accepting = false; }
		try {
			const override = await options.toolHooks?.afterToolCall?.({ ...hookContext(call, args), result, isError: result.isError === true }, signal);
			// A hook can mutate its result without returning an override. Validate and
			// detach both forms before publishing or persisting the completed result.
			result = snapshot({ ...result, ...(override ? Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) : {}) });
		} catch (error) { result = errorResult(error); }
		return { ...result, content: result.content ?? [] };
	};
	const sequential = options.toolHooks?.toolExecution === "sequential" || calls.some(call => tools.find(tool => tool.name === call.name)?.executionMode === "sequential");
	if (sequential) {
		for (const call of calls) {
			if (signal.aborted) break;
			begin(call);
			const prepared = await prepare(call);
			const result = "call" in prepared ? await execute(prepared) : prepared;
			end(call, result);
			// Commit in call order, before the next sequential side effect can begin.
			await save(call, result);
		}
	} else {
		const prepared: Array<{ call: ToolCallBlock; work: Prepared | ToolResult<unknown>; }> = [];
		for (const call of calls) {
			if (signal.aborted) break;
			begin(call); prepared.push({ call, work: await prepare(call) });
		}
		const completed = await Promise.all(prepared.map(async ({ call, work }) => {
			const result = "call" in work ? await execute(work) : work;
			end(call, result); return { call, result };
		}));
		for (const { call, result } of completed) await save(call, result);
	}
	async function save(call: ToolCallBlock, result: ToolResult<unknown>) {
		results.set(call.id, result);
		const message: SessionMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() };
		emit({ type: "message_start", message: structuredClone(message), timestamp: Date.now() });
		await persist(message);
		savedMessages.push(message);
		emit({ type: "message_end", message: structuredClone(message), timestamp: Date.now() });
	}
	return { results, messages: savedMessages, terminate: results.size > 0 && [...results.values()].every(result => result.terminate === true) };
}
