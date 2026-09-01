import type { PermissionScope, ToolCallBlock } from "@myh/protocol";

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
	return JSON.stringify(sortValue(argumentsValue));
}

export function permissionScope(toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionScope {
	return { tool: toolCall.name, argsPattern: serializeArguments(toolCall.arguments) };
}

export function formatPermissionRule(scope: PermissionScope): string {
	return `${scope.tool} ${scope.argsPattern}`;
}

export function matchesPermissionRule(rule: Pick<PermissionRule, "tool" | "argsPattern">, toolCall: Pick<ToolCallBlock, "name" | "arguments">): boolean {
	return globMatches(rule.tool, toolCall.name) && globMatches(rule.argsPattern, serializeArguments(toolCall.arguments));
}

export function findMatchingRule(rules: readonly PermissionRule[], toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionRuleMatch | undefined {
	for (const rule of rules) {
		if (matchesPermissionRule(rule, toolCall)) return { rule, scope: permissionScope(toolCall) };
	}
	return undefined;
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

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)]));
}
