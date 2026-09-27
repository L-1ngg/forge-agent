import type { HarnessTool } from "@forge-agent/tools";
import { defineLocalTool } from "@forge-agent/tools/define-builtin";
import { z } from "zod";
import { selectedBranch, type SessionState } from "../session-storage.ts";
import { evidenceText } from "./checkpoint.ts";

/** Local literal search. Offsets address original text, never the case-folded text. */
export function contextSearcher(state: () => SessionState): HarnessTool<object, unknown> {
	return defineLocalTool({
		name: "search_context", label: "Search saved context",
		description: "Find saved messages in this branch by literal query words (all must match, case-insensitive). Newest first. Optional role and limit (default 5, max 10). Returns entryId and bounded preview with Unicode offset for read_context. Not semantic search.",
		inputSchema: z.strictObject({ query: z.string().min(1).refine(value => [...value].length <= 200).describe("At most 200 Unicode code points"), role: z.enum(["user", "assistant", "toolResult"]).optional(), limit: z.number().int().min(1).max(10).optional() }),
		async execute(input, context) {
			context.signal?.throwIfAborted();
			const { query, role, limit = 5 } = input;
			if (!query.trim()) throw new Error("Context search query must contain a word");
			const words = [...new Set(query.trim().split(/\s+/u))];
			if (words.length > 8) throw new Error("Context search allows at most 8 literal words");
			const patterns = words.map(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
			const matches: Array<{ entryId: string; role: string; isError: boolean; offset: number; text: string }> = [];
			let hasMore = false;
			for (const entry of selectedBranch(state()).reverse()) {
				context.signal?.throwIfAborted();
				if (entry.type !== "message" || (role && entry.message.role !== role)) continue;
				// Retrieval traffic would otherwise match its own query and recursively echo results.
				if (["read_context", "search_context"].includes(entry.message.toolName ?? "") || entry.message.content.some(block => block.type === "tool_call" && ["read_context", "search_context"].includes(block.name))) continue;
				const text = evidenceText(entry.message), hits = patterns.map(pattern => pattern.exec(text));
				if (hits.some(hit => !hit)) continue;
				if (matches.length === limit) { hasMore = true; break; }
				const index = Math.min(...hits.map(hit => hit!.index));
				const offset = Math.max(0, [...text.slice(0, index)].length - 64);
				matches.push({ entryId: entry.id, role: entry.message.role, isError: entry.message.isError ?? false, offset, text: [...text].slice(offset, offset + 256).join("") });
			}
			const result = { matches, hasMore };
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
