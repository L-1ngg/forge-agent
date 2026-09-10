import { expect, test } from "bun:test";
import { SessionStore, messageEntry } from "@forge-agent/core";
import type { SessionMessage } from "@forge-agent/protocol";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "../src/session-host.ts";

test("preview shows six recent visible messages from the resume branch without executing or writing", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-preview-"));
	let calls = 0;
	const server = Bun.serve({ port: 0, fetch() { calls++; return new Response("unexpected"); } });
	const host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test" });
	try {
		const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", "history.jsonl"), cwd);
		const append = async (message: SessionMessage) => { const entry = messageEntry(message, store.getLeafId()); await store.append(entry); return entry.id; };
		const root = await append({ role: "user", content: [{ type: "text", text: "same opening" }], timestamp: 1 });
		await append({ role: "assistant", content: [{ type: "text", text: "WRONG_BRANCH" }], timestamp: 2 });
		store.branch(root);
		for (let i = 0; i < 5; i++) await append({ role: "user", content: [{ type: "text", text: `recent ${i}` }], timestamp: 3 + i });
		const boundary = store.getLeafId()!;
		await append({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, { type: "text", text: "🙂".repeat(501) }], stopReason: "aborted", timestamp: 8 });
		await append({ role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "TOOL_BODY" }], timestamp: 9 });
		await store.append({ type: "compaction", id: "compact", parentId: store.getLeafId(), timestamp: new Date(10).toISOString(), summary: "NOT_ORIGINAL", firstKeptEntryId: boundary, tokensBefore: 100 });
		await append({ role: "user", content: [{ type: "image", data: "not-base64", mimeType: "image/png" }], timestamp: 11 });
		const id = (await host.list()).sessions[0]!.id;
		const before = await readFile(id, "utf8");
		const active = host.current;
		const preview = await host.preview(id);
		expect(preview.messages).toHaveLength(6);
		expect(preview.messages[0]?.text).toBe("recent 1");
		expect(preview.messages[4]).toEqual({ role: "assistant", text: "🙂".repeat(500), truncated: true, stopReason: "aborted" });
		expect(preview.messages[5]?.text).toBe("[图片]");
		for (const hidden of ["WRONG_BRANCH", "PRIVATE_THOUGHT", "TOOL_BODY", "NOT_ORIGINAL"]) expect(JSON.stringify(preview)).not.toContain(hidden);
		expect(host.current).toBe(active);
		expect(calls).toBe(0);
		expect(await readFile(id, "utf8")).toBe(before);
	} finally { await host.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

test("list and preview reuse unchanged files and invalidate additions, edits and deletions", async () => {
	const fs = await import("node:fs/promises");
	const { spyOn } = await import("bun:test");
	const cwd = await mkdtemp(join(tmpdir(), "forge-preview-cache-"));
	const host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	const path = join(cwd, ".forge-agent", "sessions", "history.jsonl");
	const store = await SessionStore.open(path, cwd);
	await store.append(messageEntry({ role: "user", content: [{ type: "text", text: "opening" }], timestamp: 1 }, null));
	const observer = spyOn(fs, "readFile");
	const reads = () => observer.mock.calls.filter(args => String(args[0]).endsWith(".jsonl")).length;
	try {
		const id = (await host.list()).sessions[0]!.id;
		const coldReads = reads();
		expect(coldReads).toBeGreaterThan(0);
		await host.list(); expect(reads()).toBe(coldReads);
		const preview = await host.preview(id);
		const firstPreviewReads = reads();
		expect(firstPreviewReads).toBeGreaterThan(coldReads);
		expect(await host.preview(id, preview)).toEqual(preview);
		expect(reads()).toBe(firstPreviewReads);
		await store.append(messageEntry({ role: "assistant", content: [{ type: "text", text: "new work" }], timestamp: 20 }, store.getLeafId()));
		expect((await host.list()).sessions[0]?.updatedAt).toBe(20);
		expect((await host.preview(id, preview)).messages.at(-1)?.text).toBe("new work");
		const another = await SessionStore.open(join(cwd, ".forge-agent", "sessions", "new.jsonl"), cwd);
		await another.append(messageEntry({ role: "user", content: [{ type: "image", data: "image", mimeType: "image/png" }], timestamp: 30 }, null));
		expect((await host.list()).sessions.map(item => item.title)).toEqual(["无文本会话", "opening"]);
		await fs.rm(id);
		expect((await host.list()).sessions).toHaveLength(1);
		await expect(host.preview(id, preview)).rejects.toThrow();
	} finally { observer.mockRestore(); await host.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("a file changed during preview reading is not cached as a current snapshot", async () => {
	const fs = await import("node:fs/promises");
	const { spyOn } = await import("bun:test");
	const cwd = await mkdtemp(join(tmpdir(), "forge-preview-changing-"));
	const host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" });
	const store = await SessionStore.open(join(cwd, ".forge-agent", "sessions", "changing.jsonl"), cwd);
	await store.append(messageEntry({ role: "user", content: [{ type: "text", text: "before read" }], timestamp: 1 }, null));
	const id = (await host.list()).sessions[0]!.id;
	const read = fs.readFile;
	let changed = false;
	const observer = spyOn(fs, "readFile").mockImplementation(new Proxy(read, { apply(target, receiver, args) {
		const result = Reflect.apply(target, receiver, args);
		if (String(args[0]) !== id || changed) return result;
		changed = true;
		return result.then(async (body: string) => {
			await store.append(messageEntry({ role: "assistant", content: [{ type: "text", text: "appended during read" }], timestamp: 2 }, store.getLeafId()));
			return body;
		});
	} }));
	try {
		const old = await host.preview(id);
		expect(old.messages.at(-1)?.text).toBe("before read");
		const fresh = await host.preview(id, old);
		expect(fresh.messages.at(-1)?.text).toBe("appended during read");
	} finally { observer.mockRestore(); await host.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
