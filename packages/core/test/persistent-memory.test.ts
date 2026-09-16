import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongTermMemory } from "../src/sdk.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-")); directories.push(root);
	return { root, memory: new LongTermMemory({ project: root }) };
}

test("saved Markdown and program source survive a new memory instance without requiring metadata", async () => {
	const { root, memory } = await fixture();
	const saved = await memory.write({ scope: "project", path: "notes/project.md", content: "首版采用 Markdown。", expectedVersion: null, operationId: "save-1" }, { kind: "management", timestamp: "2026-09-17T00:00:00.000Z" });
	expect(saved.saved).toBe(true);
	const reopened = new LongTermMemory({ project: root });
	const note = await reopened.read("project", "notes/project.md");
	expect(note.text).toContain("首版采用 Markdown。");
	expect(note.sources).toContainEqual(expect.objectContaining({ kind: "management" }));
	await writeFile(join(root, "handwritten.md"), "直接手写普通 Markdown，无元数据。");
	expect((await reopened.search("project", "普通 Markdown")).matches[0]?.path).toBe("handwritten.md");
});

test("stale edits cannot replace external changes or resurrect deleted notes; retries do not commit again", async () => {
	const { root, memory } = await fixture();
	const source = { kind: "management" as const, timestamp: "2026-09-17T00:00:00Z" };
	const create = { scope: "project" as const, path: "note.md", content: "original", expectedVersion: null, operationId: "create" };
	await memory.write(create, source);
	const before = await memory.read("project", "note.md");
	await writeFile(join(root, "note.md"), "human correction");
	await expect(memory.write({ ...create, content: "stale", expectedVersion: before.version, operationId: "stale" }, source)).rejects.toThrow("changed");
	await expect(memory.write(create, source)).resolves.toMatchObject({ saved: true, replayed: true });
	expect((await memory.read("project", "note.md")).text).toBe("human correction");
	const current = await memory.read("project", "note.md");
	await memory.delete("project", "note.md", current.version, "delete");
	await expect(memory.write({ ...create, expectedVersion: current.version, operationId: "old-update" }, source)).rejects.toThrow("changed");
	expect((await memory.search("project", "human")).matches).toHaveLength(0);
});

test("search reaches unindexed long Markdown while reads page and report malformed metadata", async () => {
	const { root, memory } = await fixture();
	await writeFile(join(root, "long.md"), "---\nbroken: [\n---\n" + "正文".repeat(3000) + "\nsrc/cache.ts E_MEM42 myIdentifier 搜索词");
	const first = await memory.read("project", "long.md");
	expect(first.nextOffset).toBe(4096);
	expect(first.warnings.join(" ")).toContain("frontmatter");
	const result = await memory.search("project", "src/cache.ts E_MEM42 myIdentifier 搜索词");
	expect(result.matches).toHaveLength(1);
	expect(result.matches[0]?.text).toContain("E_MEM42");
});

test("malformed source annotations cannot bypass the paged response budget", async () => {
	const { root, memory } = await fixture();
	await writeFile(join(root, "sources.md"), "<!-- forge-memory-source x -->\n".repeat(6000));
	const page = await memory.read("project", "sources.md");
	expect(page.nextOffset).toBe(4096);
	expect(page.warnings.length).toBeLessThanOrEqual(6);
	expect(JSON.stringify(page).length).toBeLessThan(8192);
});

test("scope and symlink escapes are rejected; damaged text and oversized files stay untouched", async () => {
	const { root, memory } = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "forge-memory-outside-")); directories.push(outside);
	await writeFile(join(outside, "secret.md"), "private");
	await symlink(outside, join(root, "escape"));
	await expect(memory.read("project", "escape/secret.md")).rejects.toThrow("symlink");
	await expect(memory.read("user", "secret.md")).rejects.toThrow("authorized");
	await expect(memory.read("project", "../secret.md")).rejects.toThrow("path");
	await writeFile(join(root, "broken.md"), new Uint8Array([255, 254, 0]));
	await expect(memory.read("project", "broken.md")).rejects.toThrow();
	await writeFile(join(root, "large.md"), "x".repeat(256 * 1024 + 1));
	await expect(memory.read("project", "large.md")).rejects.toThrow("resource limit");
	await expect(memory.read("project", "missing.md")).rejects.toMatchObject({ code: "ENOENT" });
});

test("competing managed writers settle once and interrupted publication preserves the complete old file", async () => {
	const { root, memory } = await fixture();
	await writeFile(join(root, "note.md"), "original");
	const before = await memory.read("project", "note.md");
	const source = { kind: "management" as const, timestamp: "now" };
	const input = { scope: "project" as const, path: "note.md", content: "replacement", expectedVersion: before.version, operationId: "write" };
	const failing = new LongTermMemory({ project: root }, { ...fs, async rename(from, to) { if (to === join(root, "note.md")) throw new Error("injected publication failure"); return fs.rename(from, to); } });
	await expect(failing.write(input, source)).rejects.toThrow("injected");
	expect((await memory.read("project", "note.md")).text).toBe("original");
	const results = await Promise.allSettled([memory.write(input, source), new LongTermMemory({ project: root }).write({ ...input, operationId: "competing" }, source)]);
	expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
	expect((await memory.read("project", "note.md")).text).toContain("replacement");
	const controller = new AbortController(); controller.abort();
	await expect(memory.write({ ...input, path: "canceled.md", expectedVersion: null }, source, controller.signal)).rejects.toThrow();
	expect(await memory.list("project")).toEqual(["note.md"]);
});

test("pin management survives reopening and broken links never supply the deleted note", async () => {
	const { root, memory } = await fixture();
	await writeFile(join(root, "pinned.md"), "Fixed preference");
	await memory.pin("project", "pinned.md", true);
	expect(await new LongTermMemory({ project: root }).pinned("project")).toEqual(["pinned.md"]);
	await rm(join(root, "pinned.md"));
	const links = await memory.checkLinks("project", "[fixed](pinned.md)");
	expect(links.text).toContain("unavailable");
	await memory.pin("project", "pinned.md", false);
	expect(await memory.pinned("project")).toEqual([]);
});

test("separate processes serialize managed writes and reject the losing stale plan", async () => {
	const { root, memory } = await fixture();
	await writeFile(join(root, "shared.md"), "old");
	const original = await memory.read("project", "shared.md");
	const script = `import { LongTermMemory } from ${JSON.stringify(join(import.meta.dir, "../src/sdk.ts"))}; const [root, version, id] = Bun.argv.slice(1); try { await new LongTermMemory({project:root}).write({scope:"project",path:"shared.md",content:id,expectedVersion:version,operationId:id},{kind:"management",timestamp:"fixed"}); } catch(error) { console.error(String(error)); process.exit(2); }`;
	const children = ["writer-a", "writer-b"].map(id => Bun.spawn([process.execPath, "-e", script, root, original.version, id], { stdout: "pipe", stderr: "pipe" }));
	const codes = await Promise.all(children.map(child => child.exited));
	expect(codes.sort()).toEqual([0, 2]);
	const errors = await Promise.all(children.map(child => new Response(child.stderr).text()));
	expect(errors.join("")).toContain("changed");
	expect((await memory.read("project", "shared.md")).text).toMatch(/writer-[ab]/);
});

test("an index saved beyond its actual injection allocation reports both success and shortening", async () => {
	const { memory } = await fixture();
	const result = await memory.write({ scope: "project", path: "MEMORY.md", content: "index ".repeat(500), expectedVersion: null, operationId: "small-budget", indexBudgetTokens: 500 }, { kind: "management", timestamp: "fixed" });
	expect(result.saved).toBe(true);
	expect(result.warnings.join(" ")).toContain("shorten");
	expect((await memory.read("project", "MEMORY.md")).text).toContain("index index");
});

test("two writers recovering a killed writer cannot remove each other's live ownership", async () => {
	const { root, memory } = await fixture();
	await writeFile(join(root, "shared.md"), "old");
	const original = await memory.read("project", "shared.md");
	let locked!: () => void; const ready = new Promise<void>(resolve => { locked = resolve; });
	const childScript = `import * as fs from "node:fs/promises"; import { LongTermMemory } from ${JSON.stringify(join(import.meta.dir, "../src/sdk.ts"))}; const [root,version]=Bun.argv.slice(1); await new LongTermMemory({project:root},{...fs,async writeFile(path,data,options){if(String(data).startsWith("DEAD_WRITER")){process.send?.("locked"); await new Promise(()=>{});} return fs.writeFile(path,data,options);}}).write({scope:"project",path:"shared.md",content:"DEAD_WRITER",expectedVersion:version,operationId:"dead"},{kind:"management",timestamp:"fixed"});`;
	const child = Bun.spawn([process.execPath, "-e", childScript, root, original.version], { stdout: "ignore", stderr: "pipe", ipc(message) { if (message === "locked") locked(); } });
	try { await ready; } finally { child.kill("SIGKILL"); await child.exited; }
	let reads = 0, lockPath = "", removals = 0;
	let bothRead!: () => void, entered!: () => void, release!: () => void;
	const readGate = new Promise<void>(resolve => { bothRead = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
	const enteredWriters = new Set<string>();
	const fileOps = (id: string): typeof fs => ({ ...fs,
		readFile: (async (path: Parameters<typeof fs.readFile>[0], options: Parameters<typeof fs.readFile>[1]) => {
			const value = await fs.readFile(path, options);
			if (String(value).includes(`"pid":${child.pid},`) && reads < 2) { lockPath = String(path); if (++reads === 2) bothRead(); await readGate; }
			return value;
		}) as typeof fs.readFile,
		async unlink(path) { if (String(path) === lockPath && ++removals === 2) await inside; return fs.unlink(path); },
		async open(path, flags, mode) {
			if (String(path) === join(root, "shared.md") && flags === "r" && !enteredWriters.has(id)) { enteredWriters.add(id); entered(); await finish; }
			return fs.open(path, flags, mode);
		},
	});
	const writes = ["a", "b"].map(id => new LongTermMemory({ project: root }, fileOps(id)).write({ scope: "project", path: "shared.md", content: id, expectedVersion: original.version, operationId: id }, { kind: "management", timestamp: "fixed" }));
	try { await inside; await Bun.sleep(40); expect(enteredWriters.size).toBe(1); }
	finally { release(); await Promise.allSettled(writes); }
	const outcomes = await Promise.allSettled(writes); expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
}, 10000);
