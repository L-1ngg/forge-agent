/** Transport-neutral parser and completion values shared by all clients. */
export interface SlashCommandInvocation {
	command: string;
	args: string;
	argv: string[];
	raw: string;
	start: number;
	end: number;
}

export interface SlashCommandPrefix {
	prefix: string;
	start: number;
	end: number;
}

export interface MentionToken {
	path: string;
	raw: string;
	start: number;
	end: number;
}

export interface InputCompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface InputCompletionSuggestions {
	items: InputCompletionItem[];
	prefix: string;
}

export interface SkillInvocation { kind: "skill"; name: string; task: string; }
export interface McpPromptInvocation { kind: "mcp_prompt"; serverId: string; name: string; arguments?: Record<string, string>; task: string; }
export interface McpResourceInvocation { kind: "mcp_resource"; serverId: string; uri: string; task: string; }
export interface McpInputContext {
 kind: "mcp_prompt" | "mcp_resource"; serverId: string; name: string; arguments?: Record<string, string>;
 fetchedAt: number; catalogRevision: number;
 originalMessages?: unknown;
 messages: Array<{ role: "user" | "assistant"; content: import("./events.ts").SessionContentBlock[] }>;
 artifacts: Array<{ id: string; mimeType: string; size: number }>;
 task?: string;
}
export type AgentInput = string | SkillInvocation | McpPromptInvocation | McpResourceInvocation;
