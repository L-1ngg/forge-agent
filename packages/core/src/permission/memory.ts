import type { PermissionScope, ToolCallBlock } from "@myh/protocol";
import { matchesPermissionRule, type PermissionRule, type PermissionRuleMatch, permissionScope } from "./rules.ts";

export interface RememberedPermission extends PermissionScope {
	createdAt: number;
}

interface StoredPermission {
	scope: RememberedPermission;
	/** Explicitly remembered scopes are exact; configured glob scopes retain glob semantics. */
	exact: boolean;
}

export interface PermissionMemory {
	match(toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionRuleMatch | undefined;
	remember(scope: PermissionScope): void;
	entries(): readonly RememberedPermission[];
}

/** In-memory store; persistence belongs to a later phase and cannot weaken scope checks. */
export class MemoryPermissionStore implements PermissionMemory {
	private readonly scopes: StoredPermission[] = [];

	constructor(initial: readonly PermissionScope[] = []) {
		for (const scope of initial) {
			const normalized = normalizeScope(scope);
			if (normalized) this.add(normalized, isCanonicalArguments(normalized.argsPattern));
		}
	}

	match(toolCall: Pick<ToolCallBlock, "name" | "arguments">): PermissionRuleMatch | undefined {
		const scope = permissionScope(toolCall);
		for (const stored of this.scopes) {
			const remembered = stored.scope;
			const matches = stored.exact
				? remembered.tool === scope.tool && remembered.argsPattern === scope.argsPattern
				: matchesPermissionRule({ tool: remembered.tool, argsPattern: remembered.argsPattern }, toolCall);
			if (matches) {
				const rule: PermissionRule = { tool: remembered.tool, argsPattern: remembered.argsPattern, effect: "allow", rememberable: true };
				return { rule, scope };
			}
		}
		return undefined;
	}

	remember(scope: PermissionScope): void {
		const normalized = normalizeScope(scope);
		if (!normalized) return;
		this.add(normalized, true);
	}

	entries(): readonly RememberedPermission[] {
		return this.scopes.map(({ scope }) => ({ ...scope }));
	}

	private add(scope: PermissionScope, exact: boolean): void {
		if (this.scopes.some((entry) => entry.scope.tool === scope.tool && entry.scope.argsPattern === scope.argsPattern)) return;
		this.scopes.push({ scope: { ...scope, createdAt: Date.now() }, exact });
	}
}

export function memoryFromScopes(scopes: readonly PermissionScope[] | undefined): PermissionMemory {
	return new MemoryPermissionStore(scopes);
}

function normalizeScope(scope: PermissionScope): PermissionScope | undefined {
	return typeof scope?.tool === "string" && scope.tool.length > 0 && typeof scope.argsPattern === "string" && scope.argsPattern.length > 0
		? { tool: scope.tool, argsPattern: scope.argsPattern }
		: undefined;
}

function isCanonicalArguments(value: string): boolean {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}
