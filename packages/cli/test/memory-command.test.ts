import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongTermMemory, type MemoryOptions } from "@forge-agent/core/sdk";
import { MemoryManager } from "../src/memory-command.ts";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

test("memory management saves explicitly with auto/injection off and uses the user's last read for edits", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-command-")); directories.push(root);
	const options: MemoryOptions = { store: new LongTermMemory({ project: root }), autoUpdate: false, injection: false };
	const manager = new MemoryManager(options);
	expect((await manager.execute("save project note.md 只在项目中使用 Bun")).text).toContain('"saved": true');
	expect((await manager.execute("read project note.md")).text).toContain("只在项目中使用 Bun");
	await writeFile(join(root, "note.md"), "human correction");
	await expect(manager.execute("edit project note.md stale edit")).rejects.toThrow("changed");
	await manager.execute("read project note.md");
	await manager.execute("edit project note.md new correction");
	await manager.execute("pin project note.md");
	expect(await options.store.pinned("project")).toEqual(["note.md"]);
	await manager.execute("read project note.md");
	expect((await manager.execute("delete project note.md")).text).toContain("会话历史");
	expect(await options.store.list("project")).toEqual([]);
	await manager.execute("auto on"); expect(options.autoUpdate).toBe(true);
	expect(options.injection).toBe(false);
	const budgeted = new MemoryManager(options, undefined, () => 100);
	expect((await budgeted.execute("save project MEMORY.md " + "index ".repeat(100))).text).toContain("100-token");
});
