import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/sdk.ts";

const model = { provider: "openai", model: "gpt-4o-mini", apiKey: "fixture", systemPrompt: "BASE", thinkingLevel: "off" as const };
async function skill(root: string, name: string, body = "SECRET BODY", header = "") {
	const dir = join(root, name); await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\n${/^name:/m.test(header) ? "" : `name: ${name}\n`}${/^description:/m.test(header) ? "" : `description: ${name} workflow\n`}${header}---\n${body}`);
}
test("SDK discovers workspace before user, preserves diagnostics, and defaults to disabled", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	try {
		await skill(join(cwd, "workspace"), "guide"); await skill(join(cwd, "user"), "guide");
		const agent = await createAgent({ ...model, cwd, skills: { roots: { workspace: { path: "workspace" }, user: { path: "user" } } } });
		try {
			const snapshot = agent.getSkills();
			expect(snapshot.enabled).toBe(true);
			expect(snapshot.entries.map(entry => [entry.name, entry.layer, entry.status])).toEqual([["guide", "workspace", "available"], ["guide", "user", "shadowed"]]);
			expect(JSON.stringify(snapshot)).not.toContain("SECRET BODY");
			snapshot.entries.length = 0;
			expect(agent.getSkills().entries).toHaveLength(2);
		} finally { await agent.dispose(); }
		const disabled = await createAgent({ ...model, cwd });
		expect(disabled.getSkills()).toMatchObject({ enabled: false, entries: [] }); await disabled.dispose();
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

import { HttpFixture } from "../../../tests/support/http-fixture.ts";
import { modelResponse } from "./helpers/model-response.ts";
import { MemorySessionStorage } from "../src/sdk.ts";
const anthropic = { ...model, provider: "anthropic", model: "claude-sonnet-4-5" };
const allow = { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] };
test("production SDK discloses only metadata then loads full body and provenance through real tool/history", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	await skill(cwd, "guide", "\nSECRET BODY\r\nUse references/note.md.\n\n");
	await writeFile(join(cwd, "guide", "note.md"), "PRIVATE REFERENCE");
	const storage = new MemorySessionStorage();
	const fixture = new HttpFixture("skills-load", [
		{ id: "catalog", method: "POST", path: "/v1/messages", match(body) {
				const request = JSON.stringify(body); expect(request).toContain("guide workflow"); expect(request).toContain("load_skill");
				expect(request).not.toContain("SECRET BODY"); expect(request).not.toContain(cwd); expect(request).not.toContain("PRIVATE REFERENCE");
			}, response: { chunks: [await modelResponse([{ id: "load", name: "load_skill", arguments: { name: "guide" } }]).text()] } },
		{ id: "loaded", method: "POST", path: "/v1/messages", match(body) {
				const request = JSON.stringify(body); expect(request).toContain("SECRET BODY"); expect(request).toContain(cwd); expect(request).toContain("sha256:"); expect(request).not.toContain("PRIVATE REFERENCE");
			}, response: { chunks: [await modelResponse().text()] } },
	]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, storage, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	try {
		for await (const _event of agent.runTurn("Help with guide")) {}
		await fixture.verify();
		expect(JSON.stringify(await storage.load())).toContain("SECRET BODY");
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("explicit-only selection preserves raw task once; rejected input has an id, zero requests and leaves agent reusable", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	await skill(cwd, "manual", "\nMANUAL BODY\r\n", "disable-model-invocation: true\nallowed-tools: Bash\n");
	const task = '  keep "quotes"\nsecond line  ';
	const storage = new MemorySessionStorage();
	const fixture = new HttpFixture("explicit", [{ id: "selected", method: "POST", path: "/v1/messages", match(body) {
		const request = body as { system: unknown; messages: Array<{ role: string; content: Array<{ text: string }> }> };
		expect(JSON.stringify(request.system)).not.toContain("manual workflow");
		const text = request.messages[0]!.content[0]!.text;
		expect(text).toContain("MANUAL BODY\r\n"); expect(text.endsWith(task)).toBe(true); expect(text.split(task)).toHaveLength(2);
	}, response: { chunks: [await modelResponse().text()] } }]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, storage, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	try {
		const rejected = agent.runTurn({ kind: "skill", name: "unknown", task }); const events: SessionEvent[] = [];
		for await (const event of rejected) events.push(event);
		expect(rejected.inputId).toBeString(); expect(await rejected.result).toEqual({ status: "error" });
		expect(events).toContainEqual(expect.objectContaining({ type: "skill_input", inputId: rejected.inputId, code: "unknown-skill" }));
		expect(fixture.count).toBe(0); expect(JSON.stringify(await storage.load())).not.toContain(task);
		for await (const _event of agent.runTurn({ kind: "skill", name: "manual", task })) {}
		await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

import { symlink, rename } from "node:fs/promises";
test("real directories: stable aliases, broken links, loops, nested ignores and invalid candidates", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	try {
		const workspace = join(cwd, "workspace"), user = join(cwd, "user");
		await skill(workspace, "guide", "workspace", "compatibility: 12\n"); await skill(user, "guide", "user");
		await skill(join(workspace, "z"), "same"); await skill(join(workspace, "a"), "same");
		await skill(workspace, "ignored"); await skill(workspace, "root"); await skill(join(workspace, "root/references"), "hidden");
		await skill(join(workspace, "group/deep"), "skip"); await skill(join(workspace, "other"), "skip");
		await writeFile(join(workspace, ".gitignore"), "ignored/\n"); await writeFile(join(workspace, "group/.ignore"), "deep/\n");
		await writeFile(join(cwd, ".gitignore"), "*\n");
		await symlink(join(workspace, "a/same"), join(workspace, "alias"));
		await symlink(workspace, join(workspace, "loop")); await symlink(join(cwd, "absent"), join(workspace, "broken"));
		const agent = await createAgent({ ...model, cwd, skills: { roots: { workspace: { path: workspace }, user: { path: user }, builtin: { path: "missing", optional: true } } } });
		try {
			const list = agent.getSkills(); const active = list.entries.filter(entry => entry.status === "available");
			expect(active.map(entry => entry.name)).toEqual(["same", "skip", "root", "guide"]);
			expect(active.find(entry => entry.name === "guide")?.layer).toBe("user");
			expect(list.entries.find(entry => entry.entry.includes("/alias/"))?.status).toBe("duplicate");
			expect(list.entries.find(entry => entry.entry.includes("/z/"))?.status).toBe("shadowed");
			expect(list.diagnostics.some(item => item.entry.endsWith("broken"))).toBe(true);
			expect(JSON.stringify(list)).not.toContain("hidden"); expect(JSON.stringify(list)).not.toContain("ignored/SKILL");
			const old = agent.getSkills(); await rename(workspace, workspace + "-moved");
			await expect(agent.refreshSkills()).rejects.toThrow("Unable to scan"); expect(agent.getSkills()).toEqual(old);
		} finally { await agent.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const [header, valid] of [
	["license: MIT\ncompatibility: Bun\nmetadata: {version: '1'}\nallowed-tools: Bash\ncustom: {anything: true}\n", true],
	["name: 12\n", false], ["description: []\n", false], ["description: ''\n", false],
	["license: {}\n", false], ["compatibility: ''\n", false], ["compatibility: " + "x".repeat(501) + "\n", false],
	["metadata: {version: 1}\n", false], ["allowed-tools: []\n", false], ["disable-model-invocation: 'true'\n", false],
	["description: " + "x".repeat(1025) + "\n", false],
] as const) test(`SDK validates standard metadata ${header.slice(0, 35)}`, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	try {
		await skill(cwd, "guide", "body", header);
		const agent = await createAgent({ ...model, cwd, skills: { roots: { workspace: { path: cwd } } } });
		try { expect(agent.getSkills().entries[0]?.status).toBe(valid ? "available" : "invalid"); } finally { await agent.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const [body, ok] of [["x".repeat(50 * 1024), true], ["x".repeat(50 * 1024 + 1), false], ["中".repeat(17066) + "ab", true], ["中".repeat(17066) + "abc", false]] as const) test(`explicit UTF-8 body limit: ${Buffer.byteLength(body)} bytes`, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide", body);
	const fixture = new HttpFixture("limit", ok ? [{ id: "full", method: "POST", path: "/v1/messages", match(request) { expect(JSON.stringify(request)).toContain(body); }, response: { chunks: [await modelResponse().text()] } }] : []);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	try {
		const turn = agent.runTurn({ kind: "skill", name: "guide", task: "task" }); const events: SessionEvent[] = [];
		for await (const event of turn) events.push(event);
		expect((await turn.result).status).toBe(ok ? "success" : "error");
		if (!ok) expect(events).toContainEqual(expect.objectContaining({ type: "skill_input", code: "too-large" }));
		await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("automatic explicit-only and unknown errors; explicit changed and missing files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide"); await skill(cwd, "manual", "manual", "disable-model-invocation: true\n");
	const calls = [{ id: "manual", name: "load_skill", arguments: { name: "manual" } }, { id: "unknown", name: "load_skill", arguments: { name: "../../etc/passwd" } }];
	const fixture = new HttpFixture("errors", [
		{ id: "ask", method: "POST", path: "/v1/messages", match() {}, response: { chunks: [await modelResponse(calls).text()] } },
		{ id: "errors", method: "POST", path: "/v1/messages", match(body) { const text = JSON.stringify(body); expect(text).toContain("explicit-only"); expect(text).toContain("unknown-skill"); expect(text).not.toContain("SECRET BODY"); }, response: { chunks: [await modelResponse().text()] } },
	]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	try {
		for await (const _event of agent.runTurn("try")) {}
		for (const action of ["changed", "missing"] as const) {
			if (action === "changed") await skill(cwd, "guide", "NEW BODY"); else await rm(join(cwd, "guide/SKILL.md"));
			const events: SessionEvent[] = []; for await (const event of agent.runTurn({ kind: "skill", name: "guide", task: "task" })) events.push(event);
			expect(events).toContainEqual(expect.objectContaining({ type: "skill_input", code: action }));
		}
		await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("explicit deny ignores allowed-tools, emits rejection before receipt, and oversized catalog never requests a model", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide", "body", "allowed-tools: load_skill\n");
	const fixture = new HttpFixture("no-requests", []);
	try {
		for (const deny of [true, false]) {
			const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, skills: { roots: { workspace: { path: cwd } } }, permission: deny ? { mode: "deny-all" } : allow, ...(deny ? {} : { contextWindow: 300, maxTokens: 50, context: { enabled: false, reserveTokens: 50 } }) });
			try {
				const events: SessionEvent[] = []; for await (const event of agent.runTurn({ kind: "skill", name: "guide", task: "task" })) events.push(event);
				expect(events).toContainEqual(expect.objectContaining({ type: "skill_input", code: deny ? "permission-denied" : "too-large" }));
			} finally { await agent.dispose(); }
		}
		await fixture.verify();
	} finally { fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

import { barrier, bounded } from "../../../tests/support/control.ts";
import { response, type SessionEvent } from "@forge-agent/protocol";
test("SDK keeps a whole tool batch on the old catalog and atomically applies sources/prompt before next request", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(join(cwd, "old"), "guide", "OLD_BODY"); await skill(join(cwd, "new"), "guide", "NEW_BODY");
	const started = barrier("skill batch starts"), release = barrier("release skill batch");
	const fixture = new HttpFixture("atomic-skills", [
		{ id: "old", method: "POST", path: "/v1/messages", match() {}, response: { chunks: [await modelResponse([{ id: "hold", name: "hold", arguments: {} }, { id: "load", name: "load_skill", arguments: { name: "guide" } }]).text()] } },
		{ id: "new", method: "POST", path: "/v1/messages", match(body) { const text = JSON.stringify(body); expect(text).toContain("NEW_SYSTEM"); expect(text).toContain("OLD_BODY"); expect(text).not.toContain("NEW_BODY"); expect(text.split("<available_skills>")).toHaveLength(2); }, response: { chunks: [await modelResponse().text()] } },
		{ id: "selected-new", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("NEW_BODY"); }, response: { chunks: [await modelResponse().text()] } },
	]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: "old" } } }, tools: [{ name: "hold", label: "Hold", description: "Controlled tool", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { started.release(); await release.wait(); return { content: [], details: {} }; } }] });
	const running = (async () => { for await (const _event of agent.runTurn("start")) {} })();
	try {
		await started.wait(); const old = agent.getSkills();
		const receipt = await agent.updateConfiguration({ skills: { roots: { workspace: { path: "new" } } }, systemPrompt: "NEW_SYSTEM" });
		expect(agent.getSkills()).toEqual(old); let applied = false; void receipt.applied.then(() => { applied = true; }); await Promise.resolve(); expect(applied).toBe(false);
		release.release(); await bounded(running, "batch settles"); expect(await receipt.applied).toMatchObject({ status: "applied" });
		expect(agent.getSkills().entries[0]?.entry).toContain("/new/");
		for await (const _event of agent.runTurn({ kind: "skill", name: "guide", task: "next" })) {}
		await fixture.verify();
	} finally { release.release(); await running; await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

for (const cancel of [false, true]) test(`explicit preparation holds its request snapshot; cancel=${cancel}`, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(join(cwd, "old"), "guide", "OLD_BODY"); await skill(join(cwd, "new"), "guide", "NEW_BODY");
	const fixture = new HttpFixture("prepare", cancel ? [] : [{ id: "old", method: "POST", path: "/v1/messages", match(body) { const text = JSON.stringify(body); expect(text).toContain("OLD_BODY"); expect(text).not.toContain("NEW_BODY"); expect(text).not.toContain("NEW_SYSTEM"); }, response: { chunks: [await modelResponse().text()] } }]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, skills: { roots: { workspace: { path: "old" } } } });
	const turn = agent.runTurn({ kind: "skill", name: "guide", task: "task" }); const events: SessionEvent[] = [];
	const running = (async () => { for await (const event of turn) events.push(event); })();
	try {
		const permission = await bounded(agent.requests[Symbol.asyncIterator]().next(), "explicit permission");
		const receipt = await agent.updateConfiguration({ skills: { roots: { workspace: { path: "new" } } }, systemPrompt: "NEW_SYSTEM" });
		if (cancel) await agent.dispose(); else agent.respond(response(permission.value!.id, { decision: "allow_once" }));
		await bounded(running, "explicit settles");
		expect(await receipt.applied).toMatchObject({ status: cancel ? "canceled" : "applied" });
		expect((await turn.result).status).toBe(cancel ? "aborted" : "success"); await fixture.verify();
	} finally { await agent.dispose(); await running; fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

for (const mode of ["steer", "followUp"] as const) test(`queued Skill ${mode} reports processed false on rejection`, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide");
	const started = barrier("request started"), release = barrier("response released");
	const fixture = new HttpFixture("queued", [
		{ id: "first", method: "POST", path: "/v1/messages", match() { started.release(); }, response: { chunks: [await modelResponse().text()], beforeChunk: () => release.wait() } },
	]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	const turn = agent.runTurn("start"); const events: SessionEvent[] = [];
	const running = (async () => { for await (const event of turn) events.push(event); })();
	try {
		await started.wait(); const receipt = agent[mode]({ kind: "skill", name: "missing", task: "unprocessed" }, turn.id); expect(receipt.accepted).toBe(true);
		release.release(); await bounded(running, "queued settled");
		if (receipt.accepted) { expect(await receipt.processed).toBe(false); expect(events).toContainEqual(expect.objectContaining({ type: "skill_input", inputId: receipt.inputId, code: "unknown-skill" })); }
		await fixture.verify();
	} finally { release.release(); await running; await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

import { SessionStore } from "../src/sdk.ts";
import { readFile, stat } from "node:fs/promises";
test("reopening actual storage preserves old Skill evidence while refresh and a second instance remain independent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	const firstRoot = join(cwd, "first"), secondRoot = join(cwd, "second");
	await skill(firstRoot, "guide", "FIRST_BODY"); await skill(secondRoot, "guide", "SECOND_BODY");
	const sentinel = join(cwd, "executed"); await writeFile(join(firstRoot, "guide/setup.sh"), `touch ${sentinel}`);
	const completion = await modelResponse().text();
	const fixture = (id: string, expected: string) => new HttpFixture(id, [{ id: "input", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain(expected); }, response: { chunks: [completion] } }]);
	// Each instance has a strict independent provider and real file storage.
	const firstFixture = fixture("first", "FIRST_BODY"), secondFixture = fixture("second", "SECOND_BODY");
	const file = join(cwd, "first.jsonl");
	const storage = SessionStore.create(file, cwd, "skills-session");
	const first = await createAgent({ ...anthropic, cwd, baseUrl: firstFixture.url, permission: allow, storage, skills: { roots: { workspace: { path: firstRoot } } } });
	const second = await createAgent({ ...anthropic, cwd, baseUrl: secondFixture.url, permission: allow, storage: SessionStore.create(join(cwd, "second.jsonl"), cwd, "second"), skills: { roots: { workspace: { path: secondRoot } } } });
	try {
		await Promise.all([first, second].map(async agent => { for await (const _event of agent.runTurn({ kind: "skill", name: "guide", task: "save evidence" })) {} }));
		await firstFixture.verify(); await secondFixture.verify();
		const oldRevision = first.getSkills().entries[0]!.contentRevision;
		const oldBytes = await readFile(file, "utf8");
		await first.dispose(); await skill(firstRoot, "guide", "CHANGED_BODY"); await skill(firstRoot, "added", "ADDED");
		const reopened = await createAgent({ ...anthropic, cwd, permission: allow, storage: await SessionStore.open(file, cwd, { create: false }), skills: { roots: { workspace: { path: firstRoot } } } });
		try {
			expect(reopened.getSkills().entries.find(entry => entry.name === "guide")!.contentRevision).not.toBe(oldRevision);
			expect(await readFile(file, "utf8")).toBe(oldBytes); expect(oldBytes).toContain("FIRST_BODY"); expect(oldBytes).not.toContain("CHANGED_BODY");
			await rm(join(firstRoot, "added"), { recursive: true }); const receipt = await reopened.refreshSkills(); expect(await receipt.applied).toMatchObject({ status: "applied" }); expect(reopened.getSkills().entries).toHaveLength(1);
			expect(second.getSkills().revision).toBe(0); expect(JSON.stringify(await readFile(join(cwd, "second.jsonl"), "utf8"))).not.toContain("FIRST_BODY");
			await expect(stat(sentinel)).rejects.toThrow();
		} finally { await reopened.dispose(); }
	} finally { await first.dispose(); await second.dispose(); firstFixture.close(); secondFixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("auto loader uses rewrites and hooks, blocks deny rules and refuses same-name host tool conflicts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide");
	const fixture = new HttpFixture("hooks", [{ id: "call", method: "POST", path: "/v1/messages", match() {}, response: { chunks: [await modelResponse([{ id: "call", name: "load_skill", arguments: { name: "wrong" } }]).text()] } }]);
	const seen: string[] = [];
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, skills: { roots: { workspace: { path: cwd } } },
		permission: { rules: [{ tool: "load_skill", argsPattern: "*", effect: "deny" }] },
		toolInputRewrites: { load_skill: () => ({ name: "guide" }) }, toolHooks: { beforeToolCall: async context => { seen.push(JSON.stringify(context.args)); return undefined; } },
	});
	try {
		const events: SessionEvent[] = []; for await (const event of agent.runTurn("try")) events.push(event);
		expect(seen).toEqual(['{"name":"guide"}']); expect(JSON.stringify(events)).not.toContain("SECRET BODY");
		expect(events.some(event => event.type === "message_end" && event.message.role === "toolResult" && event.message.isError)).toBe(true);
		await expect(agent.updateConfiguration({ tools: [{ name: "load_skill", label: "Bad", description: "bad", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { return { content: [], details: {} }; } }] })).rejects.toThrow("reserved");
		expect(agent.getSkills().enabled).toBe(true); await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("compaction retains raw load evidence and a fresh catalog can load again", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide", "LONG_BODY " + "detail ".repeat(6000));
	const storage = new MemorySessionStorage();
	const requests = [
		modelResponse([{ id: "load", name: "load_skill", arguments: { name: "guide" } }]), modelResponse(), modelResponse(),
		modelResponse([{ id: "reload", name: "load_skill", arguments: { name: "guide" } }]), modelResponse(),
	];
	const exchanges = await Promise.all(requests.map(async (response, i) => ({ id: `step-${i}`, method: "POST", path: "/v1/messages", match(body: unknown) { expect(JSON.stringify(body)).toContain("guide workflow"); if (i === 4) expect(JSON.stringify(body)).toContain("LONG_BODY"); }, response: { chunks: [await response.text()] } })));
	const fixture = new HttpFixture("compacted-skills", exchanges);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, storage, permission: allow, maxTokens: 512, contextWindow: 64000, context: { reserveTokens: 1024, keepRecentTokens: 100 }, skills: { roots: { workspace: { path: cwd } } } });
	try {
		for await (const _event of agent.runTurn("Inspect guide")) {}
		for await (const _event of agent.runTurn("What next?")) {}
		const before = await storage.load(); const compacted = await agent.compact();
		expect(compacted.status).toBe("complete"); expect(compacted.afterTokens!).toBeLessThan(compacted.beforeTokens);
		expect((await storage.load()).entries.slice(0, before.entries.length)).toEqual(before.entries);
		for await (const _event of agent.runTurn("Load again")) {}
		await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

for (const cancel of [false, true]) test(`queued successful Skill preparation settles receipt after consumption; cancel=${cancel}`, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide");
	const started = barrier("queued start"), release = barrier("queued release");
	const fixture = new HttpFixture("queued-success", [
		{ id: "first", method: "POST", path: "/v1/messages", match() { started.release(); }, response: { chunks: [await modelResponse().text()], beforeChunk: () => release.wait() } },
		...(!cancel ? [{ id: "second", method: "POST", path: "/v1/messages", match(body: unknown) { expect(JSON.stringify(body)).toContain("SECRET BODY"); expect(JSON.stringify(body)).toContain("QUEUED_TASK"); }, response: { chunks: [await modelResponse().text()] } }] : []),
	]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	const turn = agent.runTurn("start"); const running = (async () => { for await (const _event of turn) {} })();
	try {
		await started.wait(); const receipt = agent.followUp({ kind: "skill", name: "guide", task: "QUEUED_TASK" }, turn.id);
		expect(receipt.accepted).toBe(true); if (cancel) agent.abort(); release.release(); await bounded(running, "queued complete");
		if (receipt.accepted) expect(await receipt.processed).toBe(!cancel); await fixture.verify();
	} finally { release.release(); await running; await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("byte reader preserves a CRLF delimiter across chunks and rejects oversized frontmatter", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide");
	const head = "---\r\nname: guide\r\ndescription: Exact bytes\r\n#";
	// Closing CR at byte 8191 must wait for its LF in the next chunk.
	const raw = head + "x".repeat(8191 - Buffer.byteLength(head) - 5) + "\r\n---\r\n\nBODY\r\n\n";
	await writeFile(join(cwd, "guide/SKILL.md"), raw);
	const fixture = new HttpFixture("crlf", [{ id: "read", method: "POST", path: "/v1/messages", match(body) {
		const request = body as { messages: Array<{ content: Array<{ text: string }> }> }; expect(request.messages[0]!.content[0]!.text).toContain('):\n\nBODY\r\n\n\n\nUser task:');
	}, response: { chunks: [await modelResponse().text()] } }]);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	try {
		for await (const _event of agent.runTurn({ kind: "skill", name: "guide", task: "task" })) {}
		await fixture.verify();
		await writeFile(join(cwd, "guide/SKILL.md"), "---\n#" + "x".repeat(64 * 1024));
		await agent.refreshSkills(); expect(agent.getSkills().entries[0]?.status).toBe("invalid"); expect(JSON.stringify(agent.getSkills().diagnostics)).toContain("64 KiB");
		await agent.updateConfiguration({ skills: { enabled: false, roots: { workspace: { path: "missing" } } } }); expect(agent.getSkills().enabled).toBe(false);
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("catalog budget rejects all enabled metadata without silently dropping entries, with compaction off", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	for (let i = 0; i < 25; i++) await skill(cwd, `skill-${i}`, "BODY", `description: ${"x".repeat(1000)}\n`);
	const fixture = new HttpFixture("catalog-budget", []);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, context: { enabled: false, reserveTokens: 100 }, contextWindow: 4000, maxTokens: 100, skills: { roots: { workspace: { path: cwd } } } });
	try {
		expect(agent.getSkills().entries.filter(entry => entry.status === "available")).toHaveLength(25);
		const turn = agent.runTurn("start"); const events: SessionEvent[] = []; for await (const event of turn) events.push(event);
		expect((await turn.result).status).toBe("error"); expect(JSON.stringify(events)).toContain("reduce Skill sources"); await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("ignore rules follow each source alias without hiding another alias of the same grouping directory", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(join(cwd, "external"), "guide"); await mkdir(join(cwd, "root"));
	await symlink(join(cwd, "external"), join(cwd, "root/a")); await symlink(join(cwd, "external"), join(cwd, "root/z"));
	await writeFile(join(cwd, "root/.ignore"), "a/guide/\n");
	const agent = await createAgent({ ...model, cwd, skills: { roots: { workspace: { path: "root" } } } });
	try { expect(agent.getSkills().entries[0]).toMatchObject({ name: "guide", status: "available", entry: join(cwd, "root/z/guide/SKILL.md") }); }
	finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("a YAML extension starting with dashes cannot hide explicit-only metadata", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-"));
	await skill(cwd, "guide", "BODY", "---extension: custom\ndisable-model-invocation: true\n");
	const agent = await createAgent({ ...model, cwd, skills: { roots: { workspace: { path: cwd } } } });
	try { expect(agent.getSkills().entries[0]).toMatchObject({ status: "available", disableModelInvocation: true, metadata: { "---extension": "custom" } }); }
	finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("a discovered Skill becoming malformed reports changed with refresh guidance", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-skills-")); await skill(cwd, "guide");
	const fixture = new HttpFixture("malformed-change", []);
	const agent = await createAgent({ ...anthropic, cwd, baseUrl: fixture.url, permission: allow, skills: { roots: { workspace: { path: cwd } } } });
	try {
		for (const raw of ["no frontmatter", "---\nname: [unclosed\n---\nbody"]) {
			await writeFile(join(cwd, "guide/SKILL.md"), raw);
			const events: SessionEvent[] = []; for await (const event of agent.runTurn({ kind: "skill", name: "guide", task: "task" })) events.push(event);
			expect(events).toContainEqual(expect.objectContaining({ type: "skill_input", code: "changed", message: expect.stringContaining("refresh") }));
		}
		await fixture.verify();
	} finally { await agent.dispose(); fixture.close(); await rm(cwd, { recursive: true, force: true }); }
});
