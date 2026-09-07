import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.ts";
import { messageEntry, type MessageEntry } from "../src/session-storage.ts";
import { buildContext } from "../src/context/compaction.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("multiple compactions and branches reload in order and reject invalid retained boundaries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forge-boundaries-")); dirs.push(dir);
	const store = await SessionStore.open(join(dir, "session.jsonl"), dir);
	const first = messageEntry({ role: "user", timestamp: 1, content: [{ type: "text", text: "old" }] }, null);
	const second = messageEntry({ role: "user", timestamp: 2, content: [{ type: "text", text: "kept" }] }, first.id);
	await store.append(first); await store.append(second);
	const checkpoint = { type: "compaction" as const, id: "compact-1", parentId: second.id, timestamp: new Date(3).toISOString(), summary: "summary-1", firstKeptEntryId: second.id, tokensBefore: 2 };
	await store.append(checkpoint);
	const latest = messageEntry({ role: "user", timestamp: 4, content: [{ type: "text", text: "latest" }] }, checkpoint.id);
	await store.append(latest);
	await store.append({ ...checkpoint, id: "compact-2", parentId: latest.id, summary: "summary-2", firstKeptEntryId: latest.id });
	expect(buildContext(await (await SessionStore.open(store.path, dir)).load()).map((message) => message.content)).toEqual([[{ type: "text", text: "summary-2" }], [{ type: "text", text: "latest" }]]);
	await expect(store.append({ ...checkpoint, id: "regression", parentId: "compact-2", firstKeptEntryId: first.id })).rejects.toThrow("boundary");
	store.branch(second.id);
	const toolResult = messageEntry({ role: "toolResult", toolCallId: "missing", timestamp: 5, content: [] }, second.id);
	await store.append(toolResult);
	await expect(store.append({ ...checkpoint, id: "bad-tool", parentId: toolResult.id, firstKeptEntryId: toolResult.id })).rejects.toThrow("boundary");
	const branch = await SessionStore.open(store.path, dir, { leafId: "compact-2" });
	expect(JSON.stringify(buildContext(await branch.load()))).not.toContain("summary-1");
});
test("old sessions convert to a distinct v4 copy with original branches and identities", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forge-conversion-")); dirs.push(dir);
	const source = join(dir, "old.jsonl"), target = join(dir, "new.jsonl");
	const header = { type: "session", version: 3, id: "original", timestamp: new Date(0).toISOString(), cwd: dir };
	const entries = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((id, index): MessageEntry => ({ type: "message", id, parentId: index ? "aaaaaaaa" : null, timestamp: new Date(index).toISOString(), message: { role: "user", timestamp: index, content: [{ type: "text", text: id }] } }));
	const original = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(source, original);
	await SessionStore.convertCopy(source, target, dir);
	const store = await SessionStore.open(target, dir);
	expect(store.header.version).toBe(4);
	expect(store.getEntries()).toEqual(entries);
	expect(store.getTree()[0]?.children).toHaveLength(2);
	expect(await readFile(source, "utf8")).toBe(original);
	await expect(SessionStore.convertCopy(source, target, dir)).rejects.toThrow();
});

test("malformed lines report diagnostics; only interpretable branches load and append requires a copy", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forge-conversion-")); dirs.push(dir);
	const path = join(dir, "damaged.jsonl");
	const store = await SessionStore.open(path, dir);
	const first = messageEntry({ role: "user", timestamp: 1, content: [] }, null);
	await store.append(first);
	const original = await readFile(path, "utf8");
	const orphan = { ...first, id: "orphan", parentId: "missing" };
	await writeFile(path, original + "{incomplete}\n" + JSON.stringify(orphan));
	const diagnostics: number[] = [];
	await expect(SessionStore.open(path, dir)).rejects.toThrow("missing");
	const selected = await SessionStore.open(path, dir, { leafId: first.id, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.line) });
	expect(diagnostics).toEqual([3]);
	expect(selected.messages()).toHaveLength(1);
	await expect(selected.append(messageEntry({ role: "user", timestamp: 2, content: [] }, first.id))).rejects.toThrow("appendable copy");
	const copy = await SessionStore.convertCopy(path, join(dir, "copy.jsonl"), dir, { leafId: first.id });
	await copy.append(messageEntry({ role: "user", timestamp: 2, content: [] }, first.id));
	expect((await SessionStore.open(copy.path, dir)).messages()).toHaveLength(2);
	expect(await readFile(path, "utf8")).toBe(original + "{incomplete}\n" + JSON.stringify(orphan));
});

test("complete JSON without a newline is readable but is never appended in place", async () => {
	const dir = await mkdtemp(join(tmpdir(), "forge-conversion-")); dirs.push(dir);
	const path = join(dir, "no-newline.jsonl");
	const store = await SessionStore.open(path, dir);
	const entry = messageEntry({ role: "user", timestamp: 1, content: [] }, null);
	await store.append(entry);
	await writeFile(path, (await readFile(path, "utf8")).trimEnd());
	const loaded = await SessionStore.open(path, dir);
	expect(loaded.diagnostics).toEqual([]);
	expect(loaded.messages()).toHaveLength(1);
	await expect(loaded.append(messageEntry({ role: "user", timestamp: 2, content: [] }, entry.id))).rejects.toThrow("appendable copy");
});
