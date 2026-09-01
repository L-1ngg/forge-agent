import type { SlashCommandInvocation, SlashCommandPrefix } from "@myh/protocol";

export type { SlashCommandInvocation, SlashCommandPrefix } from "@myh/protocol";

/** Parse a command only when it starts the input (after optional whitespace). */
export function parseSlashCommand(input: string): SlashCommandInvocation | undefined {
	const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(input);
	if (!match) return undefined;
	const command = match[1] ?? "";
	const args = match[2] ?? "";
	const start = input.indexOf("/");
	return { command, args, argv: tokenizeArgs(args), raw: input, start, end: input.length };
}

/** Return the currently typed command prefix for a completion menu. */
export function slashCommandPrefix(input: string): SlashCommandPrefix | undefined {
	const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]*)?$/.exec(input);
	if (!match) return undefined;
	const start = input.indexOf("/");
	return { prefix: match[1] ?? "", start, end: input.length };
}

export function tokenizeArgs(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	let tokenStarted = false;
	for (const character of value.trim()) {
		if (escaping) {
			current += character;
			escaping = false;
			tokenStarted = true;
		} else if (character === "\\" && quote !== "'") {
			escaping = true;
			tokenStarted = true;
		} else if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			tokenStarted = true;
		} else if (character === '"' || character === "'") {
			quote = character;
			tokenStarted = true;
		} else if (/\s/.test(character)) {
			if (tokenStarted) {
				tokens.push(current);
				current = "";
				tokenStarted = false;
			}
		} else {
			current += character;
			tokenStarted = true;
		}
	}
	if (escaping) current += "\\";
	if (tokenStarted || current) tokens.push(current);
	return tokens;
}

export const parseSlash = parseSlashCommand;
