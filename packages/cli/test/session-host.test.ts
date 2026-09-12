import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "../src/session-host.ts";

test("empty startup and new sessions stay ephemeral; consumed input survives restart and resume", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-sessions-"));
	const requests: unknown[] = [];
	const savedAtRequest: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.json());
		savedAtRequest.push(await readFile(host!.current.id, "utf8"));
		return new Response(JSON.stringify({ error: { message: "test failure" } }), { status: 400 });
	} });
	const options = { cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test", retry: { enabled: false } };
	let host: SessionHost | undefined;
	try {
		host = await SessionHost.create(options);
		const first = host.current.id;
		expect(await readdir(cwd)).toEqual([]);
		await host.switchTo();
		expect(host.current.id).not.toBe(first);
		expect((await host.list()).sessions).toEqual([]);
		expect(await readdir(cwd)).toEqual([]);
		for await (const _ of host.current.port.runTurn("remember this question")) { }
		expect(savedAtRequest[0]).toContain("remember this question");
		expect(host.current.hasHistory()).toBe(true);
		const saved = host.current.id;
		expect((await host.list()).sessions.map(item => item.title)).toEqual(["remember this question"]);
		await host.dispose();
		host = await SessionHost.create(options);
		expect(host.current.history).toEqual([]);
		await host.switchTo(saved);
		expect(host.current.history[0]?.content).toEqual([{ type: "text", text: "remember this question" }]);
		for await (const _ of host.current.port.runTurn("next")) { }
		expect(JSON.stringify(requests[1])).toContain("remember this question");
		expect(savedAtRequest[1]).toContain('"text":"next"');
	} finally { await host?.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

test("resume discovery shares a worktree, isolates projects, and never overwrites legacy history", async () => {
	const { mkdir, readFile, writeFile } = await import("node:fs/promises");
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const base = await mkdtemp(join(tmpdir(), "forge-projects-"));
	const git = async (...args: string[]) => {
		const child = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe" });
		const error = await new Response(child.stderr).text();
		if (await child.exited) throw new Error(error);
	};
	const hosts: SessionHost[] = [];
	try {
		const root = join(base, "repo"), sub = join(root, "src"), other = join(base, "worktree"), plain = join(base, "plain");
		await mkdir(sub, { recursive: true }); await mkdir(plain);
		await git("init", root);
		await git("-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
		await git("-C", root, "worktree", "add", "--detach", other);
		// Exercise path aliases on Linux too (macOS tmpdir commonly aliases /private/var).
		const alias = join(base, "repo-alias");
		await symlink(root, alias, "dir");
		const legacyPath = join(alias, "src", ".forge-agent", "session.jsonl");
		const legacy = await SessionStore.open(legacyPath, sub);
		await legacy.append(messageEntry({ role: "user", content: [{ type: "text", text: "legacy question" }], timestamp: 100 }, null));
		const before = await readFile(legacyPath, "utf8");
		const options = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", systemPrompt: "test" };
		for (const cwd of [root, sub, other, plain]) hosts.push(await SessionHost.create({ ...options, cwd }));
		expect((await hosts[0]!.list()).sessions.map(item => item.title)).toEqual(["legacy question"]);
		expect((await hosts[1]!.list()).sessions.map(item => item.title)).toEqual(["legacy question"]);
		expect((await hosts[2]!.list()).sessions).toEqual([]);
		expect((await hosts[3]!.list()).sessions).toEqual([]);
		const discovered = await hosts[0]!.list();
		expect(discovered.diagnostics).toEqual([]);
		const legacyId = discovered.sessions[0]!.id;
		expect(legacyId).toBe(await realpath(legacyPath));
		await hosts[0]!.switchTo(legacyId);
		expect(await readFile(legacyPath, "utf8")).toBe(before);
		// A damaged, non-appendable target must not replace the active instance.
		await hosts[0]!.switchTo();
		const active = hosts[0]!.current.id;
		await writeFile(legacyPath, before.trimEnd());
		await expect(hosts[0]!.switchTo(legacyId)).rejects.toThrow("Session contains damaged records");
		expect(hosts[0]!.current.id).toBe(active);
	} finally { for (const host of hosts) await host.dispose(); await rm(base, { recursive: true, force: true }); }
});

test("resuming a compacted session rebuilds summary context and keeps the full visible history", async () => {
	const { SessionStore, messageEntry } = await import("@forge-agent/core");
	const { modelResponse } = await import("../../core/test/helpers/model-response.ts");
	const cwd = await mkdtemp(join(tmpdir(), "forge-resume-summary-"));
	const bodies: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { bodies.push(await request.text()); return modelResponse(); } });
	let host: SessionHost | undefined;
	try {
		const store = await SessionStore.open(join(cwd, ".forge-agent", "session.jsonl"), cwd);
		const old = messageEntry({ role: "user", content: [{ type: "text", text: "ORIGINAL_OLD" }], timestamp: 1 }, null);
		const recent = messageEntry({ role: "user", content: [{ type: "text", text: "RECENT_TEXT" }], timestamp: 2 }, old.id);
		await store.append(old); await store.append(recent);
		await store.append({ type: "compaction", id: "summary", parentId: recent.id, timestamp: new Date(3).toISOString(), summary: "SAVED_SUMMARY", firstKeptEntryId: recent.id, tokensBefore: 100 });
		host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test" });
		const discovered = await host.list();
		expect(discovered.diagnostics).toEqual([]);
		expect(discovered.sessions).toHaveLength(1);
		expect(discovered.sessions[0]!.id).toBe(await realpath(store.path));
		await host.switchTo(discovered.sessions[0]!.id);
		expect(JSON.stringify(host.current.history)).toContain("ORIGINAL_OLD");
		for await (const _ of host.current.port.runTurn("continue")) { }
		expect(bodies[0]).toContain("SAVED_SUMMARY"); expect(bodies[0]).toContain("RECENT_TEXT"); expect(bodies[0]).not.toContain("ORIGINAL_OLD");
	} finally { await host?.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

test("first persistence failure prevents any model request and readonly open cannot create a session", async () => {
	const { writeFile } = await import("node:fs/promises");
	const { SessionStore } = await import("@forge-agent/core");
	const cwd = await mkdtemp(join(tmpdir(), "forge-first-save-"));
	let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("unexpected"); } });
	let host: SessionHost | undefined;
	try {
		await expect(SessionStore.open(join(cwd, "absent.jsonl"), cwd, { create: false })).rejects.toThrow();
		expect(await readdir(cwd)).toEqual([]);
		host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test" });
		await writeFile(join(cwd, ".forge-agent"), "block directory creation");
		const run = async () => { for await (const _ of host!.current.port.runTurn("must not reach model")) { } };
		await expect(run()).rejects.toThrow();
		expect(calls).toBe(0);
	} finally { await host?.dispose(); server.stop(true); await rm(cwd, { recursive: true, force: true }); }
});

test("project history remains resumable after its original working subdirectory is removed", async () => {
	const { mkdir } = await import("node:fs/promises");
	const { modelResponse } = await import("../../core/test/helpers/model-response.ts");
	const root = await mkdtemp(join(tmpdir(), "forge-moved-cwd-"));
	const sub = join(root, "old-src");
	await mkdir(sub);
	const git = Bun.spawn(["git", "init", root], { stdout: "ignore", stderr: "ignore" });
	expect(await git.exited).toBe(0);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return modelResponse(); } });
	const options = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local", baseUrl: server.url.toString(), systemPrompt: "test" };
	let host: SessionHost | undefined;
	try {
		host = await SessionHost.create({ ...options, cwd: sub });
		for await (const _ of host.current.port.runTurn("keep after directory removal")) { }
		const id = host.current.id;
		await host.dispose();
		await rm(sub, { recursive: true });
		host = await SessionHost.create({ ...options, cwd: root });
		expect((await host.list()).sessions.map(item => item.id)).toEqual([id]);
		await host.switchTo(id);
		expect(JSON.stringify(host.current.history)).toContain("keep after directory removal");
	} finally { await host?.dispose(); server.stop(true); await rm(root, { recursive: true, force: true }); }
});
