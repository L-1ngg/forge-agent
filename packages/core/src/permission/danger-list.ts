import type { ToolCallBlock } from "@myh/protocol";

export interface DangerMatch {
	command: "rm" | "chmod" | "kill" | "git push";
	reason: string;
}

const commandPatterns: readonly [DangerMatch["command"], RegExp][] = [
	["rm", /(?:^\s*|[;&|()\n]\s*)(?:sudo\s+)?rm\b/],
	["chmod", /(?:^\s*|[;&|()\n]\s*)(?:sudo\s+)?chmod\b/],
	["kill", /(?:^\s*|[;&|()\n]\s*)(?:sudo\s+)?kill\b/],
	["git push", /(?:^\s*|[;&|()\n]\s*)(?:sudo\s+)?git\s+push\b/],
];

/** Dangerous shell operations never inherit remembered allow rules. */
export function dangerousMatch(toolCall: Pick<ToolCallBlock, "name" | "arguments">): DangerMatch | undefined {
	if (toolCall.name !== "bash") return undefined;
	const command = toolCall.arguments.command;
	if (typeof command !== "string") return undefined;
	for (const [name, pattern] of commandPatterns) {
		if (pattern.test(command)) return { command: name, reason: `Dangerous command requires confirmation: ${name}` };
	}
	return undefined;
}

export function isDangerousToolCall(toolCall: Pick<ToolCallBlock, "name" | "arguments">): boolean {
	return dangerousMatch(toolCall) !== undefined;
}
