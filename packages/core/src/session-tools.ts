import { permissionScopeForToolCall, type PermissionResponseResult, type ToolCallBlock, type SessionMessage, type SessionEvent } from "@forge-agent/protocol";
import type { HarnessTool, ToolResult } from "@forge-agent/tools";
import type { SessionConfiguration } from "./configuration.ts";
import { decide, formatPermissionRule, type PermissionContext, type PermissionDecision } from "./permission/index.ts";
import { permissionResultFromOutcome, type RequestBus } from "./request-bus.ts";
import { MEMORY_TOOL_NAMES } from "./memory/tools.ts";
import { toolInputSchema } from "./tool-arguments.ts";
import { freeze } from "./host-callback.ts";
import { toolDefinition, convertSchemaToJsonSchema, type AnyTool, type JSONSchema } from "@tanstack/ai";
import { z } from "zod";

const approvalSchema = { reject: z.object({ reason: z.string() }) };

/** Trusted identity comes from the official tool object, never a model-supplied name. */
export function bridgeSessionTools(tools: readonly HarnessTool<object, unknown>[], native: ReadonlyMap<string, AnyTool>) {
	const internal = new Set<HarnessTool<object, unknown>>();
	const effective = [...tools, ...[...native.values()].map(tool => {
		const schema = convertSchemaToJsonSchema(tool.inputSchema) as JSONSchema;
		if (schema.type !== "object") throw new Error(`Native tool ${tool.name} requires an object schema`);
		const bridged: HarnessTool<object, unknown> = {
			name: tool.name, label: tool.name, description: tool.description, parameters: schema as HarnessTool<object, unknown>["parameters"],
			async execute(args, context) {
				const output = await tool.execute!(args, { ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.signal ? { abortSignal: context.signal } : {}), emitCustomEvent: () => {} });
				return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
			},
		};
		internal.add(bridged); return bridged;
	})];
	if (new Set(effective.map(tool => tool.name)).size !== effective.length) throw new Error("Tool name collision with an internal tool");
	return {
		effective, internal,
		bind(execute: (callId: string | undefined, args: unknown, original: boolean) => Promise<unknown>): AnyTool[] {
			return effective.map(tool => {
				const original = native.get(tool.name);
				if (original) return { ...original, needsApproval: true, approvalSchema, execute: (args: unknown, context?: { toolCallId?: string }) => execute(context?.toolCallId, args, true) } as AnyTool;
				return toolDefinition({ name: tool.name, description: tool.description, needsApproval: true, approvalSchema, inputSchema: tool.inputSchema ?? toolInputSchema(tool), outputSchema: { type: "string" } }).server((args, context) => execute(context?.toolCallId, args, false));
			});
		},
	};
}

export interface ToolCallContext {
	assistantMessage: SessionMessage;
	toolCall: ToolCallBlock;
	args: Readonly<Record<string, unknown>>;
	context: { systemPrompt: string; messages: SessionMessage[]; tools: Array<HarnessTool<object, unknown>>; };
}
export interface BeforeToolCallResult { block: boolean; reason?: string; }
export interface AfterToolCallContext extends ToolCallContext { result: ToolResult<unknown>; isError: boolean; }
export type AfterToolCallResult = Partial<ToolResult<unknown>>;
export interface ToolHooks {
	beforeToolCall?: (context: ToolCallContext, signal?: AbortSignal) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
}

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

export type PreparedToolCall = {
	call: ToolCallBlock;
	tool?: HarnessTool<object, unknown>;
	args: Record<string, unknown>;
	decision: PermissionDecision;
};

export const errorResult = (error: unknown): ToolResult<unknown> => ({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true });
export function snapshot<T>(value: T): T { JSON.stringify(value); return structuredClone(value); }

export function toolHookContext(message: SessionMessage, call: ToolCallBlock, args: Record<string, unknown>, options: SessionConfiguration, messages: SessionMessage[]): ToolCallContext {
	return {
		assistantMessage: structuredClone(message), toolCall: structuredClone(call), args,
		context: { systemPrompt: options.systemPrompt, messages: structuredClone(messages), tools: (options.tools ?? []).map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) },
	};
}

/** Prepare exactly once before an approval descriptor is shown. */
export async function prepareToolCall(message: SessionMessage, call: ToolCallBlock, input: Record<string, unknown>, options: SessionConfiguration, messages: SessionMessage[], internal: ReadonlySet<HarnessTool<object, unknown>>, signal: AbortSignal): Promise<PreparedToolCall> {
	const tool = options.tools?.find(item => item.name === call.name);
	if (!tool) return { call, args: call.arguments, decision: { kind: "deny", source: "hook", reason: `Tool ${call.name} not found` } };
	try {
		signal.throwIfAborted();
		const args = snapshot(input);
		const hook = await options.toolHooks?.beforeToolCall?.(toolHookContext(message, call, structuredClone(args), options, messages), signal);
		if (hook?.block) return { call, tool, args, decision: { kind: "deny", source: "hook", reason: hook.reason ?? "Tool execution was blocked" } };
		signal.throwIfAborted();
		const decision = internal.has(tool) ? { kind: "allow" as const, source: "built-in" as const } : decide(freeze(makeToolCall(call.id, call.name, args)), options.permission ?? {});
		return { call, tool, args, decision };
	} catch (error) {
		if (signal.aborted) throw error;
		return { call, tool, args: call.arguments, decision: { kind: "deny", source: "hook", reason: error instanceof Error ? error.message : String(error) } };
	}
}

export function rememberPermission(prepared: PreparedToolCall, result: PermissionResponseResult, context: PermissionContext | undefined): string | undefined {
	if (result.decision !== "allow_always") return undefined;
	const scope = permissionScopeForToolCall(makeToolCall(prepared.call.id, prepared.call.name, prepared.args));
	if (!prepared.decision || prepared.decision.kind !== "ask" || !prepared.decision.payload.rememberRule || !context?.memory || prepared.decision.payload.rememberRule !== formatPermissionRule(scope)) return "Always allow is unavailable for this tool call";
	if (result.scope.tool !== scope.tool || result.scope.argsPattern !== scope.argsPattern) return "Permission scope differs from the rule shown for this tool call";
	context.memory.remember(result.scope);
	return undefined;
}

export async function executePreparedTool(prepared: PreparedToolCall, message: SessionMessage, options: SessionConfiguration, messages: SessionMessage[], signal: AbortSignal, emit: (event: SessionEvent) => void): Promise<ToolResult<unknown>> {
	const { call, tool, args } = prepared;
	if (!tool) return errorResult(`Tool ${call.name} not found`);
	let accepting = true, result: ToolResult<unknown>;
	try {
		signal.throwIfAborted();
		result = snapshot(await tool.execute(structuredClone(args), { cwd: options.cwd, toolCallId: call.id, signal, onUpdate: update => {
			if (accepting) emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, content: JSON.stringify(snapshot(update)), timestamp: Date.now() });
		} }));
		if (call.name.startsWith("mcp_") && !options.model.input.includes("image")) result.content = result.content.map(part => part.type === "image" ? { type: "text", text: "This model does not support image input. Original MCP image bytes remain available in the attachment references." } : part);
	} catch (error) { result = errorResult(error); }
	finally { accepting = false; }
	try {
		const override = await options.toolHooks?.afterToolCall?.({ ...toolHookContext(message, call, structuredClone(args), options, messages), result, isError: result.isError === true }, signal);
		result = snapshot({ ...result, ...(override ? Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) : {}) });
	} catch (error) { result = errorResult(error); }
	return { ...result, content: result.content ?? [] };
}
