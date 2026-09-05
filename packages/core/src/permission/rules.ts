import { permissionScopeForToolCall, serializePermissionArguments, type PermissionScope, type ToolCallBlock } from "@forge-agent/protocol";

export type PermissionRuleEffect = "allow" | "deny";

export interface PermissionRule {
	tool: string;
	argsPattern: string;
	effect: PermissionRuleEffect;
	reason?: string;
	rememberable?: boolean;
}

export interface PermissionRuleMatch {
	rule: PermissionRule;
	scope: PermissionScope;
}

/** Stable JSON keeps object-key order from changing a remembered scope. */
export function serializeArguments(argumentsValue: Record<string, unknown>): string {
	return serializePermissionArguments(argumentsValue);
}

export function permissionScope(toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionScope {
	return permissionScopeForToolCall(toolCall);
}

export function formatPermissionRule(scope: PermissionScope): string {
	return `${scope.tool} ${scope.argsPattern}`;
}

export function matchesPermissionRule(rule: Pick<PermissionRule, "tool" | "argsPattern">, toolCall: Pick<ToolCallBlock, "name" | "arguments">): boolean {
	return globMatches(rule.tool, toolCall.name) && globMatches(rule.argsPattern, serializeArguments(toolCall.arguments));
}

export function findMatchingRule(rules: readonly PermissionRule[], toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionRuleMatch | undefined {
	let firstAllow: PermissionRuleMatch | undefined;
	for (const rule of rules) {
		if (!matchesPermissionRule(rule, toolCall)) continue;
		const match = { rule, scope: permissionScope(toolCall) };
		// A broad allow must never hide a more specific deny merely because it
		// appeared earlier in the configured table.
		if (rule.effect === "deny") return match;
		firstAllow ??= match;
	}
	return firstAllow;
}

/** Explicit glob matching: '*' spans any characters and '?' spans one. */
export function globMatches(pattern: string, value: string): boolean {
	let expression = "^";
	for (const character of pattern) {
		if (character === "*") expression += ".*";
		else if (character === "?") expression += ".";
		else expression += escapeRegex(character);
	}
	return new RegExp(`${expression}$`, "s").test(value);
}

function escapeRegex(character: string): string {
	return /[\\^$.[\]|()+{}]/.test(character) ? `\\${character}` : character;
}
