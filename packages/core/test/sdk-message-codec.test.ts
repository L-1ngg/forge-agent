import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@forge-agent/protocol";
import { createAgent, MemorySessionStorage, SessionStore, messageEntry, type SessionState } from "../src/index.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import { nativeAdapter } from "../../../tests/fixtures/native-adapter.ts";
import { nativeReply } from "../../../tests/fixtures/native-reply.ts";

const badBlocks = [null, { type: "text", text: 42 }, { type: "future", text: "lost" }, { type: "tool_call", id: "call", name: "tool", arguments: [] }, { type: "thinking", thinking: null }, { type: "image", data: "bytes" }];

test("corrupt message blocks fail file reopening with their actual record and field location", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-codec-file-"));
	try {
		const path = join(root, "session.jsonl");
		const header = { type: "session", version: 4, id: "codec", timestamp: new Date(0).toISOString(), cwd: root };
		for (const block of badBlocks) {
			const entry = { type: "message", id: "message", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "assistant", timestamp: 1, content: [block] } };
			const original = [JSON.stringify(header), "", JSON.stringify(entry), ""].join("\n");
			await writeFile(path, original);
			await expect(SessionStore.open(path, root, { create: false })).rejects.toThrow(/line 3.*message.content\[0\]/);
			expect(await readFile(path, "utf8")).toBe(original);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("custom storage loading rejects corrupt content before model requests or appends", async () => {
	const model = getCatalogModel("openai", "gpt-5.4")!;
	let calls = 0, appends = 0;
	for (const block of badBlocks) {
		const state = { leafId: "entry", entries: [{ type: "message", id: "entry", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "assistant", timestamp: 1, content: [block] } }] };
		await expect(createAgent({ cwd: "/tmp", model, systemPrompt: "BASE", adapter: nativeAdapter(model, () => { calls++; return nativeReply({ text: "unused" }); }), storage: { async load() { return state as SessionState; }, async append() { appends++; } } })).rejects.toThrow(/entries\[0\].message.content\[0\]/);
	}
	expect(calls).toBe(0); expect(appends).toBe(0);
});

test("file and memory append reject corrupt blocks without publishing a successful append", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-codec-append-"));
	try {
		const file = SessionStore.create(join(root, "file.jsonl"), root);
		const memory = new MemorySessionStorage();
		for (const store of [file, memory]) for (const block of badBlocks) {
			const entry = { type: "message", id: "bad", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "assistant", timestamp: 1, content: [block] } };
			await expect(store.append(entry as SessionState["entries"][number])).rejects.toThrow(/message.content\[0\]/);
			expect((await store.load()).entries).toEqual([]);
		}
		expect(file.saved).toBe(false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
