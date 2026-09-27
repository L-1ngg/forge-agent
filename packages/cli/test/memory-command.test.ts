import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongTermMemory, type MemoryOptions } from "@forge-agent/core/sdk";
import { MemoryManager } from "../src/memory-command.ts";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

test("memory management saves, corrects and deletes with auto/injection off", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-command-")); directories.push(root);
	const options: MemoryOptions = { store: new LongTermMemory({ project: root }), autoUpdate: false, injection: false };
	const manager = new MemoryManager(options);
	expect((await manager.execute("save project note.md 只在项目中使用 Bun")).text).toContain('"saved": true');
	expect((await manager.execute("read project note.md")).text).toContain("只在项目中使用 Bun");
	await writeFile(join(root, "note.md"), "human correction");
	await manager.execute("edit project note.md new correction");
	await manager.execute("pin project note.md");
	expect(await options.store.pinned("project")).toEqual(["note.md"]);
	expect((await manager.execute("delete project note.md")).text).toContain("会话历史");
	expect(await options.store.list("project")).toEqual([]);
	await manager.execute("auto on"); expect(options.autoUpdate).toBe(true);
	expect(options.injection).toBe(false);
	expect((await manager.execute("save project MEMORY.md [note](note.md) index")).text).toContain('"saved": true');
});

test("a rejected memory setting leaves the displayed and applied value unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-rejected-setting-")); directories.push(root);
	const options: MemoryOptions = { store: new LongTermMemory({ project: root }), autoUpdate: false, injection: true };
	const manager = new MemoryManager(options, undefined, async () => { throw new Error("configuration rejected"); });
	await expect(manager.execute("auto on")).rejects.toThrow("configuration rejected");
	expect(options.autoUpdate).toBe(false);
	expect((await manager.execute("help")).text).toContain("auto=false; inject=true");
});
