import type { MentionToken } from "@forge-agent/protocol";

export type { MentionToken } from "@forge-agent/protocol";

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
	const boundedCursor = Number.isFinite(cursor) ? Math.max(0, Math.min(input.length, Math.floor(cursor))) : input.length;
	return parseMentions(input).find((mention) => {
		if (boundedCursor < mention.start || boundedCursor > mention.end) return false;
		if (boundedCursor < mention.end) return true;
		// A cursor at the token's end is useful while the token is still the last
		// thing in the input (not after a separating whitespace character).
		return mention.end === input.length || !/\s/.test(input[mention.end] ?? "");
	});
}

export const parseMention = parseMentions;
