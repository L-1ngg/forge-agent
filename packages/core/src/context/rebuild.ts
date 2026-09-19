import type { SessionMessage } from "@forge-agent/protocol";
import { selectedBranch, type SessionState, type MessageEntry } from "../session-storage.ts";
import { checkpointText, clippedMessage } from "./checkpoint.ts";

export function compactedMessages(state: SessionState): SessionMessage[] {
	const branch = selectedBranch(state);
	const index = branch.reduce((last, entry, index) => entry.type === "compaction" ? index : last, -1);
	const entry = branch[index];
	if (entry?.type !== "compaction" || !entry.checkpoint) throw new Error("No compaction checkpoint");
	const checkpoint = entry.checkpoint;
	const history = branch.slice(0, index).filter((entry): entry is MessageEntry => entry.type === "message");
	const kept = history.filter(item => checkpoint.keptIds.includes(item.id));
	return structuredClone([
		{ role: "user" as const, content: [{ type: "text" as const, text: checkpointText(checkpoint, history, "notes") }], timestamp: Date.parse(entry.timestamp) },
		...kept.map(item => checkpoint.clippedIds.includes(item.id) ? clippedMessage(item) : item.message),
		...branch.slice(index + 1).flatMap(item => item.type === "message" ? [item.message] : []),
	]);
}
