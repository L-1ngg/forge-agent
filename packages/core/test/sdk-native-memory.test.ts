import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, LongTermMemory, MemorySessionStorage } from "../src/sdk.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import { nativeAdapter, responseChunks } from "./helpers/native-adapter.ts";
import { isMemoryOrganizerRequest } from "./helpers/native-reply.ts";
import { memoryFiles } from "../src/memory/files.ts";
import { barrier, bounded } from "../../../tests/support/control.ts";

const model = getCatalogModel("openai", "gpt-5.4")!;

test("deferred memory save uses one audited model response and a new session recalls persisted Markdown", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-native-memory-"));
	const store = new LongTermMemory({ project: root });
	let organizerCalls = 0;
	const taskAdapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		if (organizer) organizerCalls++;
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer
			? JSON.stringify({ updates: [{ action: "write", scope: "project", path: "stack.md", content: "Project uses Bun." }], indexes: [{ scope: "project", content: "[stack](stack.md) - Project uses Bun." }] })
			: "Acknowledged." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const first = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter: taskAdapter, memory: { store } });
		try {
			const turn = first.runTurn("Remember that this project uses Bun.");
			const events = []; for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			expect(organizerCalls).toBe(1);
			const save = events.find(event => event.type === "memory" && event.phase === "save");
			expect(save).toMatchObject({ status: "saved", calls: 1 });
			expect(save && "usage" in save).toBe(false);
			expect(await readFile(join(root, "stack.md"), "utf8")).toContain("Project uses Bun.");
			expect(await readFile(join(root, "MEMORY.md"), "utf8")).toContain("stack.md");
		} finally { await first.dispose(); }
		const prompts: string[] = [];
		const reopened = await createAgent({ cwd: root, systemPrompt: "BASE", model, memory: { store, autoUpdate: false }, adapter: nativeAdapter(model, async function* (request) {
			prompts.push(JSON.stringify(request.systemPrompts));
			yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "Bun" }], timestamp: 2, stopReason: "stop" });
		}) });
		try {
			const turn = reopened.runTurn("Which runtime does this project use?");
			for await (const _ of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
			expect(prompts[0]).toContain("Project uses Bun.");
		} finally { await reopened.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("host-bound memory stays isolated when sessions share a thread ID", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-host-scope-"));
	try {
		const firstRoot = join(root, "first"), secondRoot = join(root, "second");
		await mkdir(firstRoot); await mkdir(secondRoot);
		await writeFile(join(firstRoot, "MEMORY.md"), "FIRST PROJECT ONLY");
		await writeFile(join(secondRoot, "MEMORY.md"), "SECOND PROJECT ONLY");
		for (const [directory, expected, excluded] of [[firstRoot, "FIRST PROJECT ONLY", "SECOND PROJECT ONLY"], [secondRoot, "SECOND PROJECT ONLY", "FIRST PROJECT ONLY"]] as const) {
			const prompts: string[] = [];
			const agent = await createAgent({ cwd: root, sessionId: "shared-thread", systemPrompt: "BASE", model, memory: { store: new LongTermMemory({ project: directory }), autoUpdate: false }, adapter: nativeAdapter(model, async function* (request) {
				prompts.push(JSON.stringify(request.systemPrompts));
				yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1, stopReason: "stop" });
			}) });
			try {
				const turn = agent.runTurn("Read project context"); for await (const _ of turn) {}
				expect(await turn.result).toEqual({ status: "success" });
				expect(prompts[0]).toContain(expected);
				expect(prompts[0]).not.toContain(excluded);
			} finally { await agent.dispose(); }
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("deferred saves keep user memory shared while project memory stays in its host root", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-save-scope-"));
	const userRoot = join(root, "user"), firstRoot = join(root, "first"), secondRoot = join(root, "second");
	await mkdir(userRoot); await mkdir(firstRoot); await mkdir(secondRoot);
	const store = new LongTermMemory({ user: userRoot, project: firstRoot });
	const firstAdapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer
			? JSON.stringify({ updates: [
				{ action: "write", scope: "user", path: "preference.md", content: "Prefer concise replies." },
				{ action: "write", scope: "project", path: "build.md", content: "First project uses Bun." },
			], indexes: [{ scope: "user", content: "USER_INDEX [preference](preference.md)" }, { scope: "project", content: "FIRST_PROJECT_INDEX [build](build.md)" }] })
			: "Noted." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const first = await createAgent({ cwd: root, sessionId: "shared-thread", systemPrompt: "BASE", model, adapter: firstAdapter, memory: { store } });
		try {
			const turn = first.runTurn("Save my preference and this project's build setup.");
			for await (const _ of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
			expect(await readFile(join(userRoot, "preference.md"), "utf8")).toContain("Prefer concise replies.");
			expect(await readFile(join(firstRoot, "build.md"), "utf8")).toContain("First project uses Bun.");
			expect(await readdir(secondRoot)).toEqual([]);
		} finally { await first.dispose(); }
		let recalled = "";
		const reopened = await createAgent({ cwd: root, sessionId: "shared-thread", systemPrompt: "BASE", model, memory: { store: new LongTermMemory({ user: userRoot, project: secondRoot }), autoUpdate: false }, adapter: nativeAdapter(model, async function* (request) {
			recalled = JSON.stringify(request.systemPrompts);
			yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 2, stopReason: "stop" });
		}) });
		try {
			const turn = reopened.runTurn("Check memory."); for await (const _ of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
			expect(recalled).toContain("USER_INDEX");
			expect(recalled).not.toContain("FIRST_PROJECT_INDEX");
		} finally { await reopened.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("memory search accepts 150 Unicode code points", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-unicode-search-"));
	const query = "😀".repeat(150);
	const storage = new MemorySessionStorage();
	try {
		await writeFile(join(root, "note.md"), query);
		let calls = 0;
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, storage, memory: { store: new LongTermMemory({ project: root }), autoUpdate: false }, adapter: nativeAdapter(model, async function* () {
			yield* responseChunks(++calls === 1 ? { role: "assistant", content: [{ type: "tool_call", id: "memory-unicode", name: "search_memory", arguments: { scope: "project", query } }], timestamp: calls, stopReason: "tool_use" } : { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: calls, stopReason: "stop" });
		}) });
		try {
			const turn = agent.runTurn("Search memory"); for await (const _ of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
			const result = (await storage.load()).entries.find(entry => entry.type === "message" && entry.message.toolCallId === "memory-unicode");
			expect(result?.type === "message" && result.message.isError).toBe(false);
			expect(JSON.stringify(result)).toContain("note.md");
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("memory configuration applies after the current run and next recall uses the new scope", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-config-"));
	const oldRoot = join(root, "old"), newRoot = join(root, "new");
	await mkdir(oldRoot); await mkdir(newRoot);
	await writeFile(join(oldRoot, "MEMORY.md"), "OLD MEMORY");
	await writeFile(join(newRoot, "MEMORY.md"), "NEW MEMORY");
	const started = barrier("tool started"), release = barrier("tool released");
	const prompts: string[] = [];
	const eventTypes: string[] = [];
	let calls = 0;
	const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, memory: { store: new LongTermMemory({ project: oldRoot }), autoUpdate: false },
		permission: { rules: [{ tool: "hold", argsPattern: "*", effect: "allow" }] },
		tools: [{ name: "hold", label: "Hold", description: "Wait", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { started.release(); await release.wait(); return { content: [], details: {} }; } }],
		adapter: nativeAdapter(model, async function* (request) {
			prompts.push(JSON.stringify(request.systemPrompts));
			yield* responseChunks(++calls === 1 ? { role: "assistant", content: [{ type: "tool_call", id: "hold", name: "hold", arguments: {} }], timestamp: calls, stopReason: "tool_use" } : { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: calls, stopReason: "stop" });
		}),
	});
	const turn = agent.runTurn("begin");
	const running = (async () => { for await (const event of turn) eventTypes.push(event.type === "configuration" ? `${event.type}:${event.phase}` : event.type); })();
	try {
		await bounded(started.wait(), "first memory tool");
		const receipt = await agent.updateConfiguration({ memory: { store: new LongTermMemory({ project: newRoot }), autoUpdate: false }, systemPrompt: "NEW BASE" });
		let applied = false; void receipt.applied.then(() => { applied = true; });
		await Promise.resolve(); expect(applied).toBe(false);
		release.release(); await bounded(running, "memory run");
		expect(await receipt.applied).toMatchObject({ status: "applied" });
		expect(prompts[0]).toContain("OLD MEMORY");
		expect(prompts[1]).toContain("OLD MEMORY");
		expect(prompts[1]).not.toContain("NEW MEMORY");
		expect(prompts[1]).not.toContain("NEW BASE");
		expect(eventTypes.indexOf("configuration:applied")).toBeGreaterThan(eventTypes.indexOf("turn_end"));
		const next = agent.runTurn("again"); for await (const _ of next) {}
		expect(prompts[2]).toContain("NEW MEMORY");
		expect(prompts[2]).toContain("NEW BASE");
	} finally { release.release(); await running; await agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("deferred organizer sees indexed topic content before revising it", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-topic-"));
	await writeFile(join(root, "MEMORY.md"), "[deployment](deployment.md) - deployment constraints");
	await writeFile(join(root, "deployment.md"), "Production remains on Node; Bun is for local tests.");
	let organizerInput = "";
	const adapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		if (organizer) organizerInput = JSON.stringify(request.messages);
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer ? '{"updates":[],"indexes":[]}' : "Noted." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Record the deployment constraint accurately.");
			for await (const _ of turn) {}
			expect(await turn.result).toEqual({ status: "success" });
			expect(organizerInput).toContain("Production remains on Node; Bun is for local tests.");
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("no-value organization reports its call and usage without creating files", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-noop-"));
	const adapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer ? '{"updates":[],"indexes":[]}' : "Done." }], timestamp: 1, stopReason: "stop", ...(organizer ? { usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } } } : {}) });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Thanks.");
			const events = []; for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "skipped", calls: 1, usage: { totalTokens: 14, cost: 0.001 } });
			expect(await readdir(root)).toEqual([]);
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("organizer failure is observable and leaves a successful task result intact", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-fail-"));
	const adapter = nativeAdapter(model, async function* (request) {
		if (isMemoryOrganizerRequest(request)) throw new Error("organizer failed");
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Remember this durable fact.");
			const events = []; for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, receipts: [{ ok: false, error: expect.stringContaining("organizer failed") }] });
			expect(await readdir(root)).toEqual([]);
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a later invalid memory operation rejects the whole plan before any file changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-plan-"));
	const adapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer
			? JSON.stringify({ updates: [
				{ action: "write", scope: "project", path: "valid.md", content: "Should not persist" },
				{ action: "write", scope: "project", path: "../invalid.md", content: "Invalid path" },
			], indexes: [] }) : "Done." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Remember the deployment rule.");
			const events = []; for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", receipts: [{ ok: false }] });
			expect(await readdir(root)).toEqual([]);
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an invalid delete operation cannot change an existing memory topic", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-delete-plan-"));
	await writeFile(join(root, "existing.md"), "Original note");
	const adapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer
			? JSON.stringify({ updates: [{ action: "delete", scope: "project", path: "existing.md", content: "unexpected" }], indexes: [] })
			: "Done." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Update memory.");
			const events = []; for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", receipts: [{ ok: false }] });
			expect(await readFile(join(root, "existing.md"), "utf8")).toBe("Original note");
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("memory writes topics before indexes and an index I/O failure stays nonfatal", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-index-io-"));
	const writes: string[] = [];
	const store = new LongTermMemory({ project: root }, { ...memoryFiles, async writeFile(file, data, options) {
		writes.push(String(file).split("/").at(-1)!);
		if (String(file).endsWith("MEMORY.md")) throw new Error("index disk full");
		await memoryFiles.writeFile(file, data, options);
	} });
	const adapter = nativeAdapter(model, async function* (request) {
		const organizer = isMemoryOrganizerRequest(request);
		yield* responseChunks({ role: "assistant", content: [{ type: "text", text: organizer
			? JSON.stringify({ updates: [{ action: "write", scope: "project", path: "topic.md", content: "Saved topic" }], indexes: [{ scope: "project", content: "[topic](topic.md)" }] })
			: "Done." }], timestamp: 1, stopReason: "stop" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, adapter, memory: { store } });
		try {
			const turn = agent.runTurn("Remember this topic.");
			const events = []; for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, receipts: [{ ok: false, error: expect.stringContaining("index disk full") }] });
			expect(writes).toEqual(["topic.md", "MEMORY.md"]);
			expect(await readFile(join(root, "topic.md"), "utf8")).toContain("Saved topic");
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("memory prompt and tools count toward the final request limit before provider I/O", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-budget-"));
	await writeFile(join(root, "MEMORY.md"), "MEMORY_CONTENT ".repeat(350));
	let requests = 0;
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model, contextWindow: 600, maxTokens: 100, context: { enabled: false, reserveTokens: 100 }, memory: { store: new LongTermMemory({ project: root }), autoUpdate: false }, adapter: nativeAdapter(model, async function* () { requests++; yield* responseChunks({ role: "assistant", content: [{ type: "text", text: "unexpected" }], timestamp: 1, stopReason: "stop" }); }) });
		try {
			const turn = agent.runTurn("hello"); for await (const _ of turn) {}
			expect(await turn.result).toEqual({ status: "error" });
			expect(requests).toBe(0);
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});
