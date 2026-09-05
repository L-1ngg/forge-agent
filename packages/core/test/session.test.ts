import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, createPiTestPort, loadConfig, RequestBus, resolveSecret, SessionSearch, SessionStore } from "../src/index.ts";
import { MemorySessionStorage, type SessionStorage } from "../src/session-storage.ts";
import type { SessionMessage } from "@forge-agent/protocol";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "forge-agent-core-"));
	temporaryDirectories.push(path);
	return path;
}
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

test("session store appends valid v3 entries and branches in place", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const first = await store.appendTurn([
		{ role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: Date.now(), stopReason: "stop" },
	]);
	expect(first.every((entry) => /^[0-9a-f]{8}$/.test(entry.id))).toBe(true);
	expect(first[0]?.parentId).toBeNull();
	expect(first[1]?.parentId).toBe(first[0]?.id);

	store.branch(first[0]?.id ?? null);
	const branch = await store.appendTurn([{ role: "user", content: [{ type: "text", text: "branch" }], timestamp: Date.now() }]);
	expect(branch[0]?.parentId).toBe(first[0]?.id);
	expect(store.getTree()[0]?.children).toHaveLength(2);

	const reopened = await SessionStore.open(path, cwd);
	expect(reopened.getEntries()).toHaveLength(3);
});

test("session search locates and reads only matching entries", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const entries = await store.appendTurn([
		{ role: "user", content: [{ type: "text", text: "alpha decision" }], timestamp: Date.now() },
		{ role: "assistant", content: [{ type: "text", text: "beta" }], timestamp: Date.now() },
	]);
	const search = new SessionSearch(path);
	const first = entries[0];
	if (!first) throw new Error("Expected first session entry");
	expect(await search.search("DECISION")).toEqual([first.id]);
	expect((await search.readEntry(first.id))?.message.role).toBe("user");
});

test("agent runner does not persist an aborted or unpaired turn", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const runner = new AgentRunner(
		{
			async *runTurn() {
				yield { type: "message_end", timestamp: 1, message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", arguments: {} }], timestamp: 1, stopReason: "aborted" } };
				yield { type: "turn_end", timestamp: 2, stopReason: "aborted" };
				yield { type: "agent_end", timestamp: 3 };
			},
			steer() { return { accepted: false }; },
			followUp() { return { accepted: false }; },
			abort() {},
		},
		store,
	);
	const events: unknown[] = [];
	for await (const event of runner.runTurn("abort me")) events.push(event);
	expect(events).toHaveLength(3);
	expect(store.getEntries()).toHaveLength(0);
});

test("agent runner abort cancels pending blocking requests before aborting the port", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const bus = new RequestBus({ idPrefix: "runner", timeoutMs: 60_000 });
	let portAborted = false;
	const runner = new AgentRunner(
		{
			async *runTurn() {
				await bus.ask("permission", {
					toolCall: { type: "tool_call", id: "call-1", name: "write", arguments: { path: "file.txt" } },
				});
				yield { type: "agent_end", timestamp: 1 };
			},
			steer() { return { accepted: false }; },
			followUp() { return { accepted: false }; },
			abort() {
				portAborted = true;
			},
		},
		store,
		bus,
	);
	const eventsPromise = (async () => {
		const events = [];
		for await (const event of runner.runTurn("needs permission")) events.push(event);
		return events;
	})();
	await new Promise((resolve) => setTimeout(resolve, 0));
	runner.abort();
	expect(await eventsPromise).toEqual([{ type: "agent_end", timestamp: 1 }]);
	expect(portAborted).toBe(true);
	expect(bus.pendingCount).toBe(0);
	expect(store.getEntries()).toHaveLength(0);
	bus.close();
});

test("agent runner persists steering and follow-up user messages in event order", async () => {
	const cwd = await temporaryDirectory();
	const store = await SessionStore.open(join(cwd, "session.jsonl"), cwd);
	const port = createPiTestPort({ responses: [{ text: "first" }, { text: "second" }, { text: "third" }] });
	const runner = new AgentRunner(port, store);
	let queued = false;
	const emitted = [];
	for await (const event of runner.runTurn("initial")) {
		if (event.type === "message_delta" && !queued) {
			queued = true;
			runner.steer("steering");
			runner.followUp("follow-up");
		}
		if (event.type === "message_end") emitted.push(event.message);
	}
	expect(store.messages()).toEqual(emitted);
	expect(store.messages().filter((message) => message.role === "user").map((message) => message.content)).toEqual([
		[{ type: "text", text: "initial" }],
		[{ type: "text", text: "steering" }],
		[{ type: "text", text: "follow-up" }],
	]);
});

test("agent runner rolls back a failed invocation including completed tool turns", async () => {
	const cwd = await temporaryDirectory();
	const store = await SessionStore.open(join(cwd, "session.jsonl"), cwd);
	let executions = 0;
	const port = createPiTestPort({
		tools: [{
			name: "capture", label: "Capture", description: "Record execution.",
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute() { executions++; return { ok: true, value: "done" }; },
		}],
		responses: [
			{ text: "baseline" },
			{ toolCalls: [{ id: "completed", name: "capture", arguments: {} }], stopReason: "tool_use" },
			{ stopReason: "error", errorMessage: "injected provider failure" },
			{ text: "recovered" },
		],
	});
	const runner = new AgentRunner(port, store);
	for await (const _event of runner.runTurn("keep")) {}
	const before = store.messages();
	const usageBefore = port.getUsage?.()?.contextTokens;
	for await (const _event of runner.runTurn("discard")) {}
	expect(executions).toBe(1);
	expect(store.messages()).toEqual(before);
	expect(port.getUsage?.()?.contextTokens).toBe(usageBefore);
	expect((await SessionStore.open(store.path, cwd)).messages()).toEqual(before);
	for await (const _event of runner.runTurn("retry")) {}
	expect(store.messages().filter((message) => message.role === "user").map((message) => message.content)).toEqual([
		[{ type: "text", text: "keep" }], [{ type: "text", text: "retry" }],
	]);
});

test("agent runner retains deferred messages without pending tool calls", async () => {
	const cwd = await temporaryDirectory();
	const store = await SessionStore.open(join(cwd, "session.jsonl"), cwd);
	const runner = new AgentRunner(createPiTestPort({ responses: [{ text: "pending remotely", stopReason: "deferred" }] }), store);
	for await (const _event of runner.runTurn("defer")) {}
	expect(store.messages()).toHaveLength(2);
	expect(store.messages().at(-1)?.stopReason).toBe("deferred");
});

test("memory session storage isolates initial, committed, and loaded message objects", async () => {
	const history: SessionMessage[] = [{ role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "reason", thinkingSignature: "signature" }] }];
	const storage = new MemorySessionStorage(history);
	history[0]!.content = [];
	const loaded = await storage.load();
	expect(loaded[0]!.content).toEqual([{ type: "thinking", thinking: "reason", thinkingSignature: "signature" }]);
	loaded[0]!.content = [];
	const turn: SessionMessage[] = [{ role: "user", timestamp: 2, content: [{ type: "text", text: "committed" }] }];
	await storage.appendTurn(turn);
	turn[0]!.content = [];
	expect((await storage.load()).map((message) => message.content)).toEqual([
		[{ type: "thinking", thinking: "reason", thinkingSignature: "signature" }], [{ type: "text", text: "committed" }],
	]);
});

test("JSONL storage adapter restores the active branch and commits through the minimal interface", async () => {
	const cwd = await temporaryDirectory();
	const store = await SessionStore.open(join(cwd, "adapter.jsonl"), cwd);
	const storage: SessionStorage = store.asStorage();
	const message: SessionMessage = { role: "user", timestamp: 1, content: [{ type: "text", text: "stored" }] };
	expect(await storage.appendTurn([message])).toBeUndefined();
	expect(await storage.load()).toEqual([message]);
	expect(await (await SessionStore.open(store.path, cwd)).load()).toEqual([message]);
	store.branch(null);
	expect(await storage.load()).toEqual([]);
});

test("agent runner faults after commit failure and rejects subsequent runs and queued inputs", async () => {
	const storage = new MemorySessionStorage();
	const failure = new Error("injected commit failure");
	let commits = 0;
	const runner = new AgentRunner(createPiTestPort({ responses: [{ text: "answer" }] }), {
		async appendTurn() { commits++; throw failure; },
	});
	const events: string[] = [];
	const run = async () => { for await (const event of runner.runTurn("hello")) events.push(event.type); };
	await expect(run()).rejects.toBe(failure);
	expect(events.at(-1)).toBe("agent_end");
	expect(commits).toBe(1);
	await expect(run()).rejects.toThrow("recreate");
	expect(() => runner.steer("stale")).toThrow("recreate");
	expect(() => runner.followUp("stale")).toThrow("recreate");
	expect(commits).toBe(1);
	const recreated = new AgentRunner(createPiTestPort({ responses: [{ text: "retry" }] }), storage);
	for await (const _event of recreated.runTurn("fresh")) {}
	expect(await storage.load()).toHaveLength(2);
});

test("agent runner does not commit when the consumer closes at agent_end", async () => {
	let commits = 0;
	const runner = new AgentRunner(createPiTestPort({ responses: [{ text: "uncommitted" }, { text: "committed" }] }), {
		async appendTurn() { commits++; },
	});
	for await (const event of runner.runTurn("early")) {
		if (event.type === "agent_end") break;
	}
	expect(commits).toBe(0);
	for await (const _event of runner.runTurn("complete")) {}
	expect(commits).toBe(1);
});

describe("config", () => {
	test("uses the XDG Forge Agent directory and ignores legacy config and variables", async () => {
		const root = await temporaryDirectory();
		const xdg = join(root, "xdg");
		await mkdir(join(xdg, "forge-agent"), { recursive: true });
		await mkdir(join(root, ".myh"), { recursive: true });
		await writeFile(join(xdg, "forge-agent", "config.json"), JSON.stringify({ provider: "new-provider", model: "new-model" }));
		await writeFile(join(root, ".myh", "config.json"), JSON.stringify({ provider: "legacy-project" }));
		const config = await loadConfig({ cwd: root, home: root, env: { XDG_CONFIG_HOME: xdg, MYH_PROVIDER: "legacy-env" } });
		expect(config).toMatchObject({ provider: "new-provider", model: "new-model" });
	});

	test("merges global, project, and environment layers", async () => {
		const root = await temporaryDirectory();
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".config", "forge-agent"), { recursive: true });
		await mkdir(join(cwd, ".forge-agent"), { recursive: true });
		await writeFile(join(home, ".config", "forge-agent", "config.json"), JSON.stringify({ provider: "global", model: "global-model", ui: { host: "alt" } }));
		await writeFile(join(cwd, ".forge-agent", "config.json"), JSON.stringify({ model: "project-model", baseUrl: "https://proxy.example/v1", ui: { host: "main" } }));
		const config = await loadConfig({ cwd, home, env: { FORGE_AGENT_PROVIDER: "env" } });
		expect(config).toMatchObject({ provider: "env", model: "project-model", baseUrl: "https://proxy.example/v1", ui: { host: "main" } });
	});

	test("defaults an invalid ui host to alt-screen (inline host is deferred)", async () => {
		const root = await temporaryDirectory();
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(cwd, ".forge-agent"), { recursive: true });
		await writeFile(join(cwd, ".forge-agent", "config.json"), JSON.stringify({ ui: { host: "invalid" } }));
		expect((await loadConfig({ cwd, home, env: {} })).ui.host).toBe("alt");
	});

	test("resolves command and environment secrets", async () => {
		expect(await resolveSecret("!echo test-secret")).toBe("test-secret");
		expect(await resolveSecret("key-$TOKEN", { TOKEN: "value" })).toBe("key-value");
	});

	test("rejects misspelled config keys without exposing their values", async () => {
		const root = await temporaryDirectory();
		const path = join(root, ".forge-agent", "config.json");
		await mkdir(join(root, ".forge-agent"), { recursive: true });
		await writeFile(path, JSON.stringify({ provider: "xai", api_Key: "private-test-secret" }));
		let failure: unknown;
		try {
			await loadConfig({ cwd: root, home: root, env: {} });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(path);
		expect(message).toContain("api_Key");
		expect(message).toContain("apiKey");
		expect(message).not.toContain("private-test-secret");
	});

	test("loads the configured API key and allows an environment override", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, ".forge-agent"), { recursive: true });
		await writeFile(join(root, ".forge-agent", "config.json"), JSON.stringify({ provider: "xai", apiKey: "project-test-key" }));
		expect((await loadConfig({ cwd: root, home: root, env: {} })).apiKey).toBe("project-test-key");
		expect((await loadConfig({ cwd: root, home: root, env: { FORGE_AGENT_API_KEY: "env-test-key" } })).apiKey).toBe("env-test-key");
	});
});
