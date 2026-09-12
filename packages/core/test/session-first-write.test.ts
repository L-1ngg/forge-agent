import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.ts";
import { messageEntry, type SessionStorage } from "../src/session-storage.ts";

const directories: string[] = [];
async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "forge-first-write-"));
	directories.push(path);
	return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const input = (text: string, parentId: string | null = null) => messageEntry({ role: "user", content: [{ type: "text", text }], timestamp: 1 }, parentId);

test("new file storage stays ephemeral until append, then reloads the first input and serializes queued appends", async () => {
	const cwd = await directory();
	const path = join(cwd, "nested", "session.jsonl");
	const store = SessionStore.create(path, cwd, "stable-session-id");
	const storage: SessionStorage = store;
	expect(await storage.load()).toEqual({ entries: [], leafId: null });
	expect(store.saved).toBe(false);
	expect(await readdir(cwd)).toEqual([]);
	const first = input("first");
	const writing = storage.append(first);
	first.message.content = [];
	await writing;
	expect(store.saved).toBe(true);
	const reopened = await SessionStore.open(path, cwd, { create: false });
	expect(reopened.saved).toBe(true);
	expect(reopened.header).toEqual(store.header);
	expect(reopened.header.id).toBe("stable-session-id");
	expect(reopened.messages()[0]?.content).toEqual([{ type: "text", text: "first" }]);
	const second = input("second", first.id), third = input("third", second.id);
	await Promise.all([storage.append(second), storage.append(third)]);
	const records = (await readFile(path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
	expect(records.map(record => record.type)).toEqual(["session", "message", "message", "message"]);
	expect(records.slice(1).map(record => record.id)).toEqual([first.id, second.id, third.id]);
	expect(await (await SessionStore.open(path, cwd, { create: false })).load()).toEqual(await storage.load());
});

for (const deferred of [true, false]) {
	test(`first and later appends use the same branch and duplicate validation (deferred=${deferred})`, async () => {
		const cwd = await directory();
		const path = join(cwd, "session.jsonl");
		const store = deferred ? SessionStore.create(path, cwd) : await SessionStore.open(path, cwd);
		const before = deferred ? "" : await readFile(path, "utf8");
		await expect(store.append(input("orphan", "missing"))).rejects.toThrow("not found");
		expect(await store.load()).toEqual({ entries: [], leafId: null });
		if (deferred) expect(await readdir(cwd)).toEqual([]);
		else expect(await readFile(path, "utf8")).toBe(before);
		const first = input("valid");
		await store.append(first);
		await expect(store.append(first)).rejects.toThrow("Duplicate");
		await expect(store.append(input("later orphan", "missing"))).rejects.toThrow("not found");
		await store.append(input("next", first.id));
		expect((await SessionStore.open(path, cwd, { create: false })).messages()).toHaveLength(2);
	});
}

test("first write is exclusive and a collision cannot overwrite or append to the existing file", async () => {
	const cwd = await directory();
	const path = join(cwd, "session.jsonl");
	const existing = await SessionStore.open(path, cwd);
	await existing.append(input("keep existing history"));
	const before = await readFile(path, "utf8");
	const store = SessionStore.create(path, cwd);
	await expect(store.append(input("conflicting session"))).rejects.toMatchObject({ code: "EEXIST" });
	await expect(store.append(input("retry"))).rejects.toThrow("faulted");
	expect(store.saved).toBe(false);
	expect((await store.load()).entries).toEqual([]);
	expect(await readFile(path, "utf8")).toBe(before);
});

test("first I/O failure rejects queued appends and stays faulted after the filesystem is repaired", async () => {
	const cwd = await directory();
	const blocked = join(cwd, "blocked");
	await writeFile(blocked, "not a directory");
	const store = SessionStore.create(join(blocked, "session.jsonl"), cwd);
	const first = input("first"), next = input("next", first.id);
	const results = await Promise.allSettled([store.append(first), store.append(next)]);
	expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
	expect(store.saved).toBe(false);
	expect((await store.load()).entries).toEqual([]);
	await rm(blocked);
	await expect(store.append(input("retry"))).rejects.toThrow("faulted");
	expect(await readdir(cwd)).toEqual([]);
});

test("later I/O failure retains the saved prefix and never retries after the path is restored", async () => {
	const cwd = await directory();
	const path = join(cwd, "session.jsonl"), backup = join(cwd, "saved.jsonl");
	const store = SessionStore.create(path, cwd);
	const first = input("saved");
	await store.append(first);
	const before = await readFile(path, "utf8");
	await rename(path, backup); await mkdir(path);
	await expect(store.append(input("failed", first.id))).rejects.toThrow();
	await rm(path, { recursive: true }); await rename(backup, path);
	await expect(store.append(input("retry", first.id))).rejects.toThrow("faulted");
	expect(store.saved).toBe(true);
	expect((await store.load()).entries).toEqual([first]);
	expect(await readFile(path, "utf8")).toBe(before);
	const reopened = await SessionStore.open(path, cwd, { create: false });
	await reopened.append(input("explicit recovery", first.id));
	expect(reopened.messages()).toHaveLength(2);
});
