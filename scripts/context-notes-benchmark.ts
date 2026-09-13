/** Offline comparison of changed context components, not billed tokens or model quality.
 * bun scripts/context-notes-benchmark.ts
 */
import { checkpointText, type TaskCheckpoint } from "../packages/core/src/context/checkpoint.ts";
import { contextReader } from "../packages/core/src/context/read-context.ts";
import { contextSearcher } from "../packages/core/src/context/search-context.ts";
import type { MessageEntry } from "../packages/core/src/session-storage.ts";

const state = () => ({ entries: [], leafId: null });
const schema = (tool: ReturnType<typeof contextReader>) => ({ name: tool.name, description: tool.description, parameters: tool.parameters });
const oldTools = JSON.stringify([schema(contextReader(state))]);
const newTools = JSON.stringify([schema(contextReader(state)), schema(contextSearcher(state))]);
const rows = [
	{ name: "one-short-source", count: 1, detail: "" },
	{ name: "one-long-source", count: 1, detail: "evidence detail ".repeat(200) },
	{ name: "eight-moderate-sources", count: 8, detail: "recorded background ".repeat(20) },
].map(fixture => {
	const history: MessageEntry[] = Array.from({ length: fixture.count }, (_, index) => ({ type: "message", id: `source-${index}`, parentId: index ? `source-${index - 1}` : null, timestamp: new Date(0).toISOString(), message: { role: "user", timestamp: 0, content: [{ type: "text", text: `Keep constraint ${index}. ${fixture.detail}` }] } }));
	const checkpoint: TaskCheckpoint = { states: history.map((entry, index) => ({ id: `rule-${index}`, kind: "constraint", text: `Keep constraint ${index}.`, status: "active", sources: [{ entryId: entry.id, quote: `Keep constraint ${index}. ${fixture.detail}` }], supersedes: [] })), claims: [], taskChanged: false };
	const full = checkpointText(checkpoint, history), notes = checkpointText(checkpoint, history, "notes");
	const measure = (text: string, tools: string) => ({ noteCharacters: text.length, toolCharacters: tools.length, estimatedTokens: Math.ceil(text.length / 4) + Math.ceil(tools.length / 4) });
	const before = measure(full, oldTools), after = measure(notes, newTools);
	return { fixture: fixture.name, before, after, estimatedTokenChange: after.estimatedTokens - before.estimatedTokens };
});
console.log(JSON.stringify({ scope: "Changed note and tool-definition components only. Same full persisted evidence; no model calls. Character/4 estimates, not tokenizer measurements, full provider request envelopes, billed cost, summary-generation savings or semantic quality.", rows }, null, 2));
