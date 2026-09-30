import { expect, test } from "bun:test";
import type { SessionMessage } from "@forge-agent/protocol";
import { createAgent, MemorySessionStorage, type Model } from "../src/sdk.ts";
import { messageEntry, type SessionState } from "../src/session-storage.ts";
import { nativeAdapter, requestMessages } from "./helpers/native-adapter.ts";
import { nativeReply } from "./helpers/native-reply.ts";

const model: Model<string> = { id: "bounded", name: "Bounded fixture", api: "faux", provider: "host", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 20_000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function history(count: number): SessionState {
	const state: SessionState = { entries: [], leafId: null };
	const add = (message: SessionMessage) => { const entry = messageEntry(message, state.leafId); state.entries.push(entry); state.leafId = entry.id; return entry; };
	const goal = add({ role: "user", timestamp: 1, content: [{ type: "text", text: "Keep the current task constraints" }] });
	for (let index = 0; index < count; index++) {
		add({ role: "assistant", timestamp: index + 2, stopReason: "tool_use", content: [{ type: "tool_call", id: `historic-${index}`, name: "inspect", arguments: { index } }] });
		if (index % 19 !== 0) add({ role: "toolResult", timestamp: index + 2, toolCallId: `historic-${index}`, toolName: "inspect", isError: index % 17 === 0, content: [{ type: "text", text: index % 17 === 0 ? `LEGACY_FAILURE_${index}` : `LEGACY_SUCCESS_${index}` }] });
	}
	const latest = add({ role: "user", timestamp: count + 3, content: [{ type: "text", text: "Continue the task" }] });
	const checkpoint = { version: 1 as const, states: [{ id: "goal", kind: "goal" as const, status: "active" as const, text: "Keep the current task constraints", sources: [{ entryId: goal.id, quote: "Keep the current task constraints" }], supersedes: [] }], claims: [], taskChanged: false, keptIds: [latest.id], clippedIds: [], coveredIds: state.entries.map(entry => entry.id), updates: 0, rebuildReason: "fixture" };
	const entry = { type: "compaction" as const, id: "checkpoint", parentId: state.leafId, timestamp: new Date(count + 4).toISOString(), summary: "Complete historical checkpoint", firstKeptEntryId: latest.id, tokensBefore: 100_000, checkpoint };
	state.entries.push(entry); state.leafId = entry.id;
	return state;
}

for (const count of [100, 1000, 5000]) test(`${count} historical calls fit a fixed request projection and retain original evidence`, async () => {
	const storage = new MemorySessionStorage(history(count));
	let projection = "", calls = 0, transforms = 0;
	const agent = await createAgent({ cwd: "/tmp", systemPrompt: "BASE", model, maxTokens: 512, context: { enabled: false, reserveTokens: 2000, keepRecentTokens: 100 }, storage,
		transformContext: context => { transforms++; return context.messages; },
		adapter: nativeAdapter(model, request => { calls++; projection = JSON.stringify(requestMessages(request.messages)); return nativeReply({ text: "Done" }); }),
	});
	try {
		const turn = agent.runTurn("Current protected input"); for await (const _ of turn) {}
		expect(await turn.result).toEqual({ status: "success" });
		expect(calls).toBe(1); expect(transforms).toBe(1);
		const notes = JSON.parse(projection).find((message: SessionMessage) => message.content.some(block => block.type === "text" && block.text.includes("Historical task notes")));
		expect(notes).toBeDefined();
		expect(notes.content[0].text.length).toBeLessThanOrEqual(4 * (2048 + 1024));
		expect(notes.content[0].text).toContain("excerpt"); expect(notes.content[0].text).toContain("search_context");
		expect(projection).toContain("Current protected input");
		expect((await storage.load()).entries.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(block => block.type === "tool_call"))).toHaveLength(count);
	} finally { await agent.dispose(); }
});

test("omitted success, failure and unknown calls are retrievable without replay or foreign branch access", async () => {
	const state = history(1000), branchLeaf = state.leafId;
	const foreign = messageEntry({ role: "user", timestamp: 2000, content: [{ type: "text", text: "FOREIGN_SECRET" }] }, null);
	state.entries.push(foreign); state.leafId = branchLeaf;
	const storage = new MemorySessionStorage(state);
	let requests = 0, effects = 0;
	const saved = state.entries.filter(entry => entry.type === "message");
	const references = ["historic-1", "historic-17", "historic-0"].map(id => saved.find(entry => entry.message.content.some(block => block.type === "tool_call" && block.id === id))!.id);
	const adapter = nativeAdapter(model, request => {
		const messages = requestMessages(request.messages); requests++;
		if (requests === 1) {
			const notes = messages.find(message => message.content.some(block => block.type === "text" && block.text.includes("Execution index excerpt")))!;
			for (const id of references) expect(JSON.stringify(notes)).not.toContain(id);
			return nativeReply({ toolCalls: [{ id: "lookup", name: "search_context", arguments: { query: "LEGACY_SUCCESS_1", limit: 1 } }] });
		}
		if (requests === 2) return nativeReply({ toolCalls: [
			{ id: "success", name: "read_context", arguments: { entryId: saved.find(entry => entry.message.toolCallId === "historic-1")!.id } },
			{ id: "failure", name: "read_context", arguments: { entryId: saved.find(entry => entry.message.toolCallId === "historic-17")!.id } },
			{ id: "unknown", name: "read_context", arguments: { entryId: references[2] } },
			{ id: "foreign", name: "read_context", arguments: { entryId: foreign.id } },
		] });
		expect(JSON.stringify(messages)).toContain("LEGACY_SUCCESS_1"); expect(JSON.stringify(messages)).toContain("LEGACY_FAILURE_17");
		const unknown = messages.find(message => message.role === "toolResult" && message.toolCallId === "unknown");
		expect(unknown?.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining('\\"index\\":0') }));
		expect(JSON.stringify(messages)).toContain("not a saved message in the selected branch");
		expect(JSON.stringify(messages)).not.toContain("FOREIGN_SECRET");
		return nativeReply({ text: "Evidence recovered" });
	});
	const agent = await createAgent({ cwd: "/tmp", systemPrompt: "BASE", model, adapter, storage, maxTokens: 512, context: { enabled: false, reserveTokens: 2000, keepRecentTokens: 100 },
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "inspect", label: "Inspect", description: "must not replay", parameters: { type: "object", properties: { index: { type: "number" } }, required: ["index"] }, async execute() { effects++; return { content: [], details: {} }; } }],
	});
	try { const turn = agent.runTurn("Find saved evidence"); for await (const _ of turn) {} expect(await turn.result).toEqual({ status: "success" }); expect(requests).toBe(3); expect(effects).toBe(0); }
	finally { await agent.dispose(); }
});

test("oversized active checkpoint sources fail before provider I/O without changing history", async () => {
	const state = history(100), text = "Protected constraint ".repeat(1000);
	const goal = state.entries[0]!;
	if (goal.type !== "message") throw new Error("Expected goal");
	goal.message.content = [{ type: "text", text }];
	const checkpoint = state.entries.at(-1)!;
	if (checkpoint.type !== "compaction" || !checkpoint.checkpoint) throw new Error("Expected checkpoint");
	checkpoint.checkpoint.states[0]!.text = text; checkpoint.checkpoint.states[0]!.sources[0]!.quote = text;
	const storage = new MemorySessionStorage(state); let calls = 0;
	await expect(createAgent({ cwd: "/tmp", model, systemPrompt: "BASE", storage, adapter: nativeAdapter(model, () => { calls++; return nativeReply({ text: "must not dispatch" }); }) })).rejects.toThrow("protected_context_budget_exceeded");
	expect(calls).toBe(0); expect(await storage.load()).toEqual(state);
});
