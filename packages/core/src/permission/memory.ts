import type { PermissionScope, ToolCallBlock } from "@myh/protocol";
import { matchesPermissionRule, type PermissionRule, type PermissionRuleMatch, permissionScope } from "./rules.ts";

export interface RememberedPermission extends PermissionScope {
	createdAt: number;
}

export interface PermissionMemory {
	match(toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionRuleMatch | undefined;
	remember(scope: PermissionScope): void;
	entries(): readonly RememberedPermission[];
}

/** In-memory store; persistence belongs to a later phase and cannot weaken scope checks. */
export class MemoryPermissionStore implements PermissionMemory {
	private readonly scopes: RememberedPermission[] = [];

	constructor(initial: readonly PermissionScope[] = []) {
		for (const scope of initial) this.remember(scope);
	}

	match(toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionRuleMatch | undefined {
		const scope = permissionScope(toolCall);
		for (const remembered of this.scopes) {
			const rule: PermissionRule = { tool: remembered.tool, argsPattern: remembered.argsPattern, effect: "allow", rememberable: true };
			if (matchesPermissionRule(rule, toolCall)) return { rule, scope };
		}
		return undefined;
	}

	remember(scope: PermissionScope): void {
		if (!scope.tool || !scope.argsPattern) return;
		if (this.scopes.some((entry) => entry.tool === scope.tool && entry.argsPattern === scope.argsPattern)) return;
		this.scopes.push({ ...scope, createdAt: Date.now() });
	}

	entries(): readonly RememberedPermission[] {
		return this.scopes.map((scope) => ({ ...scope }));
	}
}

export function memoryFromScopes(scopes: readonly PermissionScope[] | undefined): PermissionMemory {
	return new MemoryPermissionStore(scopes);
}
