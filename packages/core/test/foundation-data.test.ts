import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@forge-agent/protocol";
import type { TextOptions } from "@tanstack/ai";
import {
	createAgent, LongTermMemory, SessionStore,
	type AgentTurn, type CompactionCheckpoint, type CreateAgentOptions, type McpArtifactStore, type MessageEntry, type Model,
} from "../src/sdk.ts";
import { replyAdapter } from "../../../tests/fixtures/native-reply.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const model: Model = {
	id: "archive-model", name: "Archive model", api: "faux", provider: "archive-provider", baseUrl: "https://unused.invalid",
	reasoning: true, input: ["text", "image"], contextWindow: 100_000, maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function entry(id: string, parentId: string | null, message: SessionMessage): MessageEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

async function consume(turn: AgentTurn) {
	for await (const _event of turn) { }
	return turn.result;
}

test("a copied pre-foundation JSONL restores through native chat, appends and reopens without rewriting source evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-foundation-history-")); directories.push(directory);
	const source = join(directory, "original.jsonl"), copy = join(directory, "working.jsonl");
	const first = entry("old-user", null, { role: "user", timestamp: 1, content: [{ type: "text", text: "Do not deploy. Inspect the original file.\n原始要求。" }] });
	const assistant = entry("old-assistant", first.id, {
		role: "assistant", timestamp: 2, api: model.api, provider: model.provider, model: model.id, stopReason: "tool_use",
		content: [
			{ type: "thinking", thinking: "Saved reasoning", thinkingSignature: "old-thinking-signature" },
			{ type: "text", text: "Saved answer before tools", textSignature: "old-text-signature" },
			{ type: "tool_call", id: "old-call", name: "inspect_archive", arguments: { path: "original.txt" }, thoughtSignature: JSON.stringify({ forge: "tanstack-tool", version: 1, metadata: { thoughtSignature: "old-gemini-signature" } }) },
		],
	});
	const result = entry("old-result", assistant.id, {
		role: "toolResult", timestamp: 3, toolCallId: "old-call", toolName: "inspect_archive", isError: false,
		content: [{ type: "text", text: "ORIGINAL_TOOL_TEXT\n原始结果。" }], details: { exactPath: "original.txt", opaque: [1, 2, 3] },
	});
	const request = entry("old-mcp", result.id, {
		role: "user", timestamp: 4, content: [{ type: "text", text: "ORIGINAL_MCP_ENVELOPE" }],
		inputContext: {
			kind: "mcp_prompt", serverId: "retired-server", name: "saved-prompt", arguments: { subject: "archive" }, fetchedAt: 4, catalogRevision: 7,
			originalMessages: [{ role: "user", content: { type: "text", text: "RAW_EXTERNAL_PROMPT" } }],
			messages: [{ role: "user", content: [{ type: "text", text: "SAVED_MCP_CONTEXT" }] }, { role: "assistant", content: [{ type: "text", text: "SAVED_EXTERNAL_EXAMPLE" }] }],
			artifacts: [{ id: "old-artifact", mimeType: "application/octet-stream", size: 4 }], task: "Continue using the saved evidence.",
		},
	});
	const messages = [first, assistant, result, request];
	const checkpoint: CompactionCheckpoint = {
		version: 1, states: [{ id: "no-deploy", kind: "constraint", text: "Do not deploy.", status: "active", sources: [{ entryId: first.id, quote: "Do not deploy." }], supersedes: [] }],
		claims: [{ kind: "fact", text: "Original output is retained.", sources: [{ entryId: result.id, quote: "ORIGINAL_TOOL_TEXT" }] }], taskChanged: false,
		keptIds: messages.map(message => message.id), clippedIds: [], coveredIds: messages.map(message => message.id), updates: 0, rebuildReason: "initial",
	};
	const compacted = { type: "compaction", id: "old-checkpoint", parentId: request.id, timestamp: new Date(5).toISOString(), summary: "Historical summary", firstKeptEntryId: first.id, tokensBefore: 100, adaptive: checkpoint };
	const sibling = entry("other-branch", first.id, { role: "user", timestamp: 6, content: [{ type: "text", text: "SIBLING_BRANCH_MUST_STAY_SEPARATE" }] });
	const original = [{ type: "session", version: 4, id: "pre-foundation-session", timestamp: new Date(0).toISOString(), cwd: directory }, ...messages, compacted, sibling].map(record => JSON.stringify(record)).join("\n") + "\n";
	await writeFile(source, original);
	await copyFile(source, copy);

	const requests: Array<Pick<TextOptions, "messages">> = [];
	let executions = 0;
	const settings = {
		cwd: directory, systemPrompt: "Archive migration test", model, skills: false, mcp: false, context: { enabled: false },
		adapter: replyAdapter(model, request => { requests.push({ messages: structuredClone(request.messages) }); return { text: "RESTORED_ANSWER" }; }),
		tools: [{ name: "inspect_archive", label: "Inspect", description: "Must never replay a saved call", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
			async execute() { executions++; return { content: [{ type: "text", text: "unexpected replay" }], details: null }; } }],
	} satisfies CreateAgentOptions;
	const restored = await SessionStore.open(copy, directory, { create: false, leafId: compacted.id });
	const agent = await createAgent({ ...settings, storage: restored });
	try { expect(await consume(agent.continue())).toEqual({ status: "success" }); }
	finally { await agent.dispose(); }

	expect(requests).toHaveLength(1);
	const sent = requests[0]!;
	const signed = sent.messages.find(message => message.toolCalls?.some(call => call.id === "old-call"));
	expect(signed).toMatchObject({
		thinking: [{ content: "Saved reasoning", signature: "old-thinking-signature" }],
		content: [{ type: "text", content: "Saved answer before tools", metadata: { forge: { textSignature: "old-text-signature" } } }],
		toolCalls: [{ id: "old-call", function: { name: "inspect_archive", arguments: '{"path":"original.txt"}' }, metadata: { thoughtSignature: "old-gemini-signature" } }],
	});
	expect(sent.messages.some(message => message.role === "tool" && message.toolCallId === "old-call" && JSON.stringify(message.content).includes("ORIGINAL_TOOL_TEXT"))).toBe(true);
	expect(JSON.stringify(sent.messages)).toContain("SAVED_MCP_CONTEXT");
	expect(JSON.stringify(sent.messages)).toContain("SAVED_EXTERNAL_EXAMPLE");
	expect(JSON.stringify(sent.messages)).toContain("Do not deploy.");
	expect(JSON.stringify(sent.messages)).not.toContain("SIBLING_BRANCH_MUST_STAY_SEPARATE");
	expect(executions).toBe(0);
	expect(restored.messages().filter(message => message.role === "user")).toHaveLength(2);
	expect(restored.getEntries()).toHaveLength(messages.length + 3);
	const appended = restored.getEntries().at(-1)!;
	expect(appended).toMatchObject({ parentId: compacted.id, type: "message", message: { role: "assistant" } });

	const reopened = await SessionStore.open(copy, directory, { create: false });
	const next = await createAgent({ ...settings, storage: reopened });
	try { expect(await consume(next.runTurn("A later task"))).toEqual({ status: "success" }); }
	finally { await next.dispose(); }
	expect(requests).toHaveLength(2);
	expect(executions).toBe(0);
	for (const message of messages) expect(reopened.getEntry(message.id)).toEqual(message);
	expect(reopened.getEntry(compacted.id)).toMatchObject({ id: compacted.id, parentId: request.id, checkpoint });
	expect(reopened.getEntry(sibling.id)).toEqual(sibling);
	expect(reopened.currentBranch().some(item => item.id === sibling.id)).toBe(false);
	expect(reopened.currentBranch().some(item => item.id === appended.id)).toBe(true);
	expect((await readFile(copy, "utf8")).startsWith(original)).toBe(true);
	expect(await readFile(source, "utf8")).toBe(original);
});

test("existing Markdown and host-owned MCP binary attachments survive SDK restore and disposal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-foundation-files-")); directories.push(directory);
	const index = "# Existing memory\n\nEXISTING_MEMORY_INDEX [details](details.md)\n";
	const details = "EXISTING_MEMORY_DETAILS\n原始 Markdown 内容。\n";
	const bytes = new Uint8Array([0, 255, 1, 128, 10]);
	await writeFile(join(directory, "MEMORY.md"), index);
	await writeFile(join(directory, "details.md"), details);
	await writeFile(join(directory, "old-artifact.bin"), bytes);
	const oldMemory = new LongTermMemory({ project: directory });
	const oldNote = await oldMemory.read("project", "details.md");
	const path = join(directory, "session.jsonl");
	const storage = SessionStore.create(path, directory);
	const saved = entry("saved-resource", null, {
		role: "user", timestamp: 1, content: [{ type: "text", text: "DURABLE_RESOURCE_ENVELOPE" }],
		inputContext: {
			kind: "mcp_resource", serverId: "offline-original", name: "archive://binary", fetchedAt: 1, catalogRevision: 3,
			messages: [{ role: "user", content: [{ type: "text", text: "SAVED_BINARY_ATTACHMENT old-artifact" }] }],
			artifacts: [{ id: "old-artifact", mimeType: "application/octet-stream", size: bytes.length }], task: "Use the saved resource.",
		},
	});
	await storage.append(saved);
	const originalHistory = await readFile(path, "utf8");
	let reads = 0;
	const requests: Array<{ messages: TextOptions["messages"]; systemPrompts: TextOptions["systemPrompts"] }> = [];
	for (let instance = 0; instance < 2; instance++) {
		const artifacts: McpArtifactStore = {
			async put() { throw new Error("Restoring saved context must not refetch or republish an attachment"); },
			async read(id) {
				expect(id).toBe("old-artifact"); reads++;
				return { bytes: await readFile(join(directory, "old-artifact.bin")), metadata: { id, mimeType: "application/octet-stream", size: bytes.length } };
			},
		};
		const reopened = await SessionStore.open(path, directory, { create: false });
		const agent = await createAgent({
			cwd: directory, model, systemPrompt: "Saved files test", skills: false, context: { enabled: false }, storage: reopened,
			adapter: replyAdapter(model, request => { requests.push({ messages: structuredClone(request.messages), systemPrompts: structuredClone(request.systemPrompts) }); return { text: "FILES_RETAINED" }; }),
			memory: { store: new LongTermMemory({ project: directory }), autoUpdate: false },
			mcp: { servers: {}, artifacts }, permission: { rules: [{ tool: "mcp_read_artifact", argsPattern: "*", effect: "allow" }] },
		});
		try {
			expect(agent.mcp.snapshot().servers).toEqual([]);
			expect(Array.from((await agent.mcp.readArtifact("old-artifact")).bytes)).toEqual(Array.from(bytes));
			expect(await consume(instance ? agent.runTurn("Continue after reopening") : agent.continue())).toEqual({ status: "success" });
			expect(reopened.getEntry(saved.id)).toEqual(saved);
		} finally { await agent.dispose(); }
	}
	expect(reads).toBe(2);
	expect(requests).toHaveLength(2);
	for (const request of requests) {
		expect(JSON.stringify(request.systemPrompts)).toContain("EXISTING_MEMORY_INDEX");
		expect(JSON.stringify(request.messages)).toContain("SAVED_BINARY_ATTACHMENT");
		expect(JSON.stringify(request.messages)).not.toContain("EXISTING_MEMORY_DETAILS");
	}
	expect(await readFile(join(directory, "MEMORY.md"), "utf8")).toBe(index);
	expect(await readFile(join(directory, "details.md"), "utf8")).toBe(details);
	expect(await new LongTermMemory({ project: directory }).read("project", "details.md")).toEqual(oldNote);
	expect(Array.from(await readFile(join(directory, "old-artifact.bin")))).toEqual(Array.from(bytes));
	const persisted = await readFile(path, "utf8");
	expect(persisted.startsWith(originalHistory)).toBe(true);
	expect(persisted).not.toContain("EXISTING_MEMORY_INDEX");
	expect(persisted).not.toContain("EXISTING_MEMORY_DETAILS");
});
