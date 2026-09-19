import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { permissionScopeForToolCall, type ToolCallBlock } from "@forge-agent/protocol";
import type { AgentOptions as RuntimeOptions } from "./runtime/agent.ts";
import type { AgentTool } from "./runtime/types.ts";
import type { ModelPortOptions } from "./pi-port.ts";
import { decide, formatPermissionRule, type PermissionContext } from "./permission/index.ts";
import { permissionResultFromOutcome, type RequestBus } from "./request-bus.ts";
import { MEMORY_TOOL_NAMES } from "./memory/tools.ts";

export function validateSessionTools(options: Pick<ModelPortOptions, "tools" | "memory">): void {
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

async function checkPermission(toolCall: ToolCallBlock, options: PermissionHookOptions, signal?: AbortSignal): Promise<PermissionCheck> {
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

/** Bridge host cwd/error outcomes to native tool scheduling; preparation and policy
 * remain serial preflight, never inside concurrently started execute promises. */
export function prepareSessionTools(options: ModelPortOptions) {
	const prepared = new Map<string, object>();
	const tools: AgentTool[] = (options.tools ?? []).map(tool => ({
		name: tool.name, label: tool.label, description: tool.description, parameters: Type.Unsafe(tool.parameters),
		...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		async execute(id, _args, signal, onUpdate) {
			signal?.throwIfAborted();
			const input = prepared.get(id);
			prepared.delete(id);
			if (!input) throw new Error("Tool input has not been authorized");
			const snapshot = <T>(result: T): T => { JSON.stringify(result); return structuredClone(result); };
			return snapshot(await tool.execute(input, { cwd: options.cwd, toolCallId: id, ...(signal ? { signal } : {}), ...(onUpdate ? { onUpdate: result => onUpdate(snapshot(result)) } : {}) }));
		},
	}));
	const beforeToolCall: NonNullable<RuntimeOptions["beforeToolCall"]> = async (context, signal) => {
		signal?.throwIfAborted();
		prepared.delete(context.toolCall.id);
		const schema = tools.find(tool => tool.name === context.toolCall.name)!;
		const nativeArgs = context.args as Record<string, unknown>;
		let args = nativeArgs;
		const rewrite = options.toolInputRewrites?.[context.toolCall.name];
		if (rewrite) args = await rewrite(args, { cwd: options.cwd, toolCallId: context.toolCall.id, ...(signal ? { signal } : {}) }) as Record<string, unknown>;
		args = validateToolArguments(schema, { ...context.toolCall, arguments: args });
		const result = await options.toolHooks?.beforeToolCall?.({ ...context, args }, signal);
		if (result?.block) return result;
		signal?.throwIfAborted();
		const finalArgs = structuredClone(validateToolArguments(schema, { ...context.toolCall, arguments: args }));
		const finalCall = makeToolCall(context.toolCall.id, context.toolCall.name, finalArgs);
		const check = await checkPermission(finalCall, { context: options.permission ?? {}, ...(options.requestBus ? { requestBus: options.requestBus } : {}) }, signal);
		if (!check.allowed) return { block: true, reason: check.reason, terminate: true };
		signal?.throwIfAborted();
		prepared.set(context.toolCall.id, finalArgs);
		// Native after hook sees the same values that were authorized and executed.
		for (const key of Object.keys(nativeArgs)) delete nativeArgs[key];
		Object.assign(nativeArgs, finalArgs);
		return result;
	};
	const afterToolCall: NonNullable<RuntimeOptions["afterToolCall"]> = async (context, signal) => {
		const isError = context.isError || ("isError" in context.result && context.result.isError === true);
		const override = await options.toolHooks?.afterToolCall?.({ ...context, isError }, signal);
		const result = { ...context.result, isError, ...Object.fromEntries(Object.entries(override ?? {}).filter(([, value]) => value !== undefined)) };
		JSON.stringify(result);
		return structuredClone(result);
	};
	return { tools, beforeToolCall, afterToolCall, ...(options.toolHooks?.toolExecution ? { toolExecution: options.toolHooks.toolExecution } : {}), clear: () => prepared.clear() };
}
