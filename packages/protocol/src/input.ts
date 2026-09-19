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
export type AgentInput = string | SkillInvocation;
