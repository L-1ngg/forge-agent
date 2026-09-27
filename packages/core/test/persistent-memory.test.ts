import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongTermMemory } from "../src/sdk.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
	const project = await mkdtemp(join(tmpdir(), "forge-memory-project-"));
	const user = await mkdtemp(join(tmpdir(), "forge-memory-user-"));
	directories.push(project, user);
	return { project, user, memory: new LongTermMemory({ project, user }) };
}

test("existing and newly written Markdown are readable across instances and scopes", async () => {
	const { project, user, memory } = await fixture();
	await writeFile(join(project, "handwritten.md"), "直接手写普通 Markdown，无元数据。");
	await memory.write({ scope: "user", path: "preference.md", content: "Prefer concise answers." }, { kind: "management", timestamp: "2026-09-28T00:00:00Z" });
	const reopened = new LongTermMemory({ project, user });
	expect((await reopened.search("project", "普通 Markdown")).matches[0]?.path).toBe("handwritten.md");
	expect((await reopened.read("user", "preference.md")).sources[0]).toMatchObject({ kind: "management", scope: "user" });
	expect((await reopened.search("project", "Prefer concise")).matches).toEqual([]);
	await reopened.write({ scope: "user", path: "preference.md", content: "Prefer direct answers." }, { kind: "management", timestamp: "2026-09-28T00:00:01Z" });
	expect((await memory.read("user", "preference.md")).text).toContain("Prefer direct answers.");
	await reopened.delete("user", "preference.md");
	expect(await reopened.list("user")).toEqual([]);
});

test("search reaches unindexed long Markdown while reads page by Unicode code points", async () => {
	const { project, memory } = await fixture();
	await writeFile(join(project, "long.md"), "前缀😀".repeat(1500) + "\nsrc/cache.ts E_MEM42 搜索词");
	const first = await memory.read("project", "long.md");
	expect(first.nextOffset).toBe(4096);
	expect([...first.text]).toHaveLength(4096);
	const result = await memory.search("project", "E_MEM42 搜索词");
	expect(result.matches[0]?.text).toContain("E_MEM42");
});

test("scope, symlink, damaged text and oversized files preserve local read boundaries", async () => {
	const { project, memory } = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "forge-memory-outside-")); directories.push(outside);
	await writeFile(join(outside, "secret.md"), "private");
	await symlink(outside, join(project, "escape"));
	await expect(memory.read("project", "escape/secret.md")).rejects.toThrow("symlink");
	await expect(memory.read("project", "../secret.md")).rejects.toThrow("path");
	await writeFile(join(project, "broken.md"), new Uint8Array([255, 254, 0]));
	await expect(memory.read("project", "broken.md")).rejects.toThrow();
	await writeFile(join(project, "large.md"), "x".repeat(256 * 1024 + 1));
	await expect(memory.read("project", "large.md")).rejects.toThrow("resource limit");
});

test("a failed write is reported as failure and never returns a saved receipt", async () => {
	const { project } = await fixture();
	const memory = new LongTermMemory({ project }, { ...fs, async writeFile() { throw new Error("disk full"); } });
	await expect(memory.write({ scope: "project", path: "note.md", content: "valuable" }, { kind: "management", timestamp: "now" })).rejects.toThrow("disk full");
	expect(await fs.readdir(project)).toEqual([]);
});
