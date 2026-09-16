import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryHost } from "../src/memory-host.ts";
import { initializeMemoryCopy, LongTermMemory } from "@forge-agent/core/sdk";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(child.stderr).text();
	if (await child.exited) throw new Error(stderr);
}

test("a real worktree inherits project Markdown once and then diverges independently", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-git-")); directories.push(root);
	const main = join(root, "main"), branch = join(root, "branch"), dataHome = join(root, "data");
	await mkdir(main); await git(main, "init");
	await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
	await git(main, "worktree", "add", "-b", "topic", branch);
	const first = await createMemoryHost(main, dataHome);
	await first.memory.write({ scope: "project", path: "MEMORY.md", content: "[背景](notes/background.md)", expectedVersion: null, operationId: "index" }, { kind: "management", timestamp: "now" });
	await first.memory.write({ scope: "project", path: "notes/background.md", content: "old background", expectedVersion: null, operationId: "background" }, { kind: "management", timestamp: "now" });
	const copy = await createMemoryHost(branch, dataHome);
	expect(copy.memory.roots.project).not.toBe(first.memory.roots.project);
	expect(copy.memory.roots.user).toBe(first.memory.roots.user);
	expect((await copy.memory.read("project", "notes/background.md")).text).toContain("old background");
	await writeFile(join(copy.memory.roots.project!, "notes/background.md"), "branch correction");
	const mainNote = await first.memory.read("project", "notes/background.md");
	await first.memory.delete("project", "notes/background.md", mainNote.version, "main-delete");
	await git(branch, "switch", "-c", "renamed-topic");
	const reopened = await createMemoryHost(branch, dataHome);
	expect((await reopened.memory.read("project", "notes/background.md")).text).toBe("branch correction");
	expect(await first.memory.list("project")).toEqual(["MEMORY.md"]);
});

test("copy initialization failure remains retryable without replacing human changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-copy-")); directories.push(root);
	const main = join(root, "main"), branch = join(root, "branch"), dataHome = join(root, "data");
	await mkdir(main); await git(main, "init");
	await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
	await git(main, "worktree", "add", "-b", "topic", branch);
	const source = await createMemoryHost(main, dataHome);
	await writeFile(join(source.memory.roots.project!, "a.md"), "original a");
	await writeFile(join(source.memory.roots.project!, "b.md"), "original b");
	let copiedTarget = "";
	await expect(createMemoryHost(branch, dataHome, { ...fs, async copyFile(from, to, mode) {
		if (String(from).endsWith("b.md")) throw new Error("injected copy failure");
		copiedTarget = String(to); return fs.copyFile(from, to, mode);
	} })).rejects.toThrow("injected copy failure");
	await writeFile(copiedTarget, "human edit during retry");
	const retry = await createMemoryHost(branch, dataHome);
	expect((await retry.memory.read("project", "a.md")).text).toBe("human edit during retry");
	expect((await retry.memory.read("project", "b.md")).text).toBe("original b");
});

test("interrupted initialization marker can recover while preserving the copied user's edits", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-marker-")); directories.push(root);
	const source = join(root, "source"), target = join(root, "target"); await mkdir(source);
	await writeFile(join(source, "note.md"), "source");
	await expect(initializeMemoryCopy(target, source, { ...fs, async writeFile(path, data, options) {
		if (String(data) === "complete\n") { await fs.writeFile(path, "com", options); throw new Error("injected short marker"); }
		return fs.writeFile(path, data, options);
	} })).rejects.toThrow("injected short marker");
	await writeFile(join(target, "note.md"), "human edit");
	await initializeMemoryCopy(target, source);
	expect((await new LongTermMemory({ project: target }).read("project", "note.md")).text).toBe("human edit");
});
