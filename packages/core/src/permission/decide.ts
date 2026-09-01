import type { PermissionRequestPayload, PermissionScope, ToolCallBlock } from "@myh/protocol";
import { dangerousMatch } from "./danger-list.ts";
import type { PermissionMemory } from "./memory.ts";
import { findMatchingRule, formatPermissionRule, permissionScope, type PermissionRule } from "./rules.ts";

export type PermissionMode = "default" | "accept-edits" | "deny-all";

export type PermissionLayerDecision =
	| { kind: "allow"; source: PermissionDecisionSource }
	| { kind: "deny"; source: PermissionDecisionSource; reason: string };

export type PermissionDecision = PermissionLayerDecision | { kind: "ask"; payload: PermissionRequestPayload };

export type PermissionDecisionSource = "hook" | "rule" | "remembered" | "built-in" | "mode";

export interface PermissionHook {
	name?: string;
	evaluate(toolCall: ToolCallBlock): PermissionLayerDecision | undefined;
}

export interface PermissionContext {
	hooks?: readonly PermissionHook[];
	rules?: readonly PermissionRule[];
	memory?: PermissionMemory;
	builtInAutoApprove?: readonly PermissionRule[];
	mode?: PermissionMode;
	/** Explicitly controls whether a prompt may offer Always allow. */
	rememberable?: boolean | ((toolCall: ToolCallBlock) => boolean);
}

/**
 * Pure five-layer permission decision: hooks -> rules -> remembered -> built-in -> mode.
 * Undefined from a layer means "continue"; the first explicit result wins.
 */
export function decide(toolCall: ToolCallBlock, context: PermissionContext = {}): PermissionDecision {
	const hookResult = firstHookDecision(toolCall, context.hooks);
	if (hookResult) return hookResult;

	const ruleMatch = findMatchingRule(context.rules ?? [], toolCall);
	if (ruleMatch) {
		if (ruleMatch.rule.effect === "deny") return { kind: "deny", source: "rule", reason: ruleMatch.rule.reason ?? `Permission rule denied ${toolCall.name}` };
		if (!dangerousMatch(toolCall)) return { kind: "allow", source: "rule" };
	}

	const danger = dangerousMatch(toolCall);
	const remembered = context.memory?.match(toolCall);
	if (remembered && !danger) return { kind: "allow", source: "remembered" };

	const builtIn = findMatchingRule(context.builtInAutoApprove ?? [], toolCall);
	if (builtIn) {
		if (builtIn.rule.effect === "deny") return { kind: "deny", source: "built-in", reason: builtIn.rule.reason ?? `Built-in policy denied ${toolCall.name}` };
		if (!danger) return { kind: "allow", source: "built-in" };
	}

	const mode = context.mode ?? "default";
	if (mode === "deny-all") return { kind: "deny", source: "mode", reason: "Permission mode deny-all blocks tool execution" };
	if (mode === "accept-edits" && isEditTool(toolCall.name) && !danger) return { kind: "allow", source: "mode" };

	const scope = permissionScope(toolCall);
	const canRemember = context.memory !== undefined && !danger && (context.rememberable === undefined
		? true
		: typeof context.rememberable === "function"
			? context.rememberable(toolCall)
			: context.rememberable);
	return {
		kind: "ask",
		payload: {
			toolCall,
			...(danger ? { reason: danger.reason } : {}),
			...(canRemember ? { rememberRule: formatPermissionRule(scope) } : {}),
		},
	};
}

function firstHookDecision(toolCall: ToolCallBlock, hooks: readonly PermissionHook[] | undefined): PermissionLayerDecision | undefined {
	for (const hook of hooks ?? []) {
		const result = hook.evaluate(toolCall);
		if (result) return { ...result, source: "hook" };
	}
	return undefined;
}

function isEditTool(name: string): boolean {
	return name === "write" || name === "edit";
}

export function permissionScopeFor(toolCall: ToolCallBlock): PermissionScope {
	return permissionScope(toolCall);
}
