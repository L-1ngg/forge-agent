import type { MentionToken } from "@myh/protocol";

export type { MentionToken } from "@myh/protocol";

/** Parse human input mentions; routing and execution remain outside this parser. */
export function parseMentions(input: string): MentionToken[] {
	const mentions: MentionToken[] = [];
	const pattern = /(^|\s)@([^\s@]*)/g;
	for (const match of input.matchAll(pattern)) {
		const prefix = match[1] ?? "";
		const path = match[2] ?? "";
		const start = (match.index ?? 0) + prefix.length;
		mentions.push({ path, raw: `@${path}`, start, end: start + path.length + 1 });
	}
	return mentions;
}

export function activeMention(input: string, cursor = input.length): MentionToken | undefined {
	return parseMentions(input).find((mention) => cursor >= mention.start && cursor <= mention.end);
}

export const parseMention = parseMentions;
