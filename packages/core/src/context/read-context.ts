import type { HarnessTool } from "@forge-agent/tools";
import { selectedBranch, type SessionState } from "../session-storage.ts";
import { evidenceText } from "./checkpoint.ts";

/** Same tool preparation, permissions and hooks as host tools; no filesystem access. */
export function contextReader(state: () => SessionState): HarnessTool<object, unknown> {
	return {
		name: "read_context", label: "Read saved context",
		description: "Read original saved message text by entryId in the current session branch. offset is zero-based Unicode code points; limit defaults to 4096, maximum 4096 (16 KiB text). Follow nextOffset to read long single lines. Does not execute historical tools or access files.",
		parameters: { type: "object", properties: { entryId: { type: "string", minLength: 1 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 4096 } }, required: ["entryId"], additionalProperties: false },
		async execute(input, context) {
			context.signal?.throwIfAborted();
			const { entryId, offset = 0, limit = 4096 } = input as { entryId: string; offset?: number; limit?: number };
			if (typeof entryId !== "string" || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new Error("Invalid context read range");
			const entry = selectedBranch(state()).find(entry => entry.id === entryId);
			if (!entry || entry.type !== "message") throw new Error("Context reference is not a saved message in the selected branch");
			const codePoints = [...evidenceText(entry.message)];
			if (offset > codePoints.length) throw new Error("Context offset is out of range");
			const end = Math.min(codePoints.length, offset + limit);
			const result = { entryId, role: entry.message.role, isError: entry.message.isError ?? false, text: codePoints.slice(offset, end).join(""), ...(end < codePoints.length ? { nextOffset: end } : {}) };
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
