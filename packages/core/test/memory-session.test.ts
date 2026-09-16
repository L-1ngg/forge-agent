import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgent, LongTermMemory, MemorySessionStorage } from "../src/sdk.ts";
import { createPiTestPort } from "../src/pi-port.ts";
import * as fs from "node:fs/promises";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

test("SDK saves memory inside the current turn through hooks and exposes durable results before completion", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-session-")); directories.push(root);
	const memory = new LongTermMemory({ project: root }), storage = new MemorySessionStorage();
	let hook = false;
	const agent = await createAgent({ provider: "faux", model: "faux-1", cwd: root, systemPrompt: "", storage,
		memory: { store: memory }, permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] },
		toolHooks: { async beforeToolCall() { hook = true; return undefined; } },
	}, options => createPiTestPort({ ...options, responses: [
		{ toolCalls: [{ id: "save", name: "write_memory", arguments: { scope: "project", path: "preference.md", content: "Project uses Bun.", expectedVersion: null } }] },
		{ text: "Saved." },
	] }));
	try {
		let observed = false;
		for await (const event of agent.runTurn("Remember: this project uses Bun.")) {
			if (event.type === "tool_execution_end") {
				expect((await new LongTermMemory({ project: root }).read("project", "preference.md")).text).toContain("Project uses Bun."); observed = true;
			}
		}
		expect(observed).toBe(true); expect(hook).toBe(true);
		const note = await memory.read("project", "preference.md");
		expect(note.sources[0]?.entryId).toBe((await storage.load()).entries.find(entry => entry.type === "message")?.id);
	} finally { await agent.dispose(); }
});

function response(): Response {
	const item = { type: "message", id: "msg_memory", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Acknowledged.", annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: "resp_memory" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Acknowledged." },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_memory", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("actual SDK request bounds index injection, preserves current input and refreshes edited/deleted notes", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-context-")); directories.push(root);
	await writeFile(join(root, "MEMORY.md"), "OLD_MEMORY_MARKER [detail](detail.md)\n" + "summary ".repeat(2000));
	await writeFile(join(root, "detail.md"), "PRIVATE_TOPIC_BODY");
	const memory = new LongTermMemory({ project: root }), storage = new MemorySessionStorage();
	const requests: Array<{ input: unknown[]; instructions?: string }> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json()); return response(); } });
	const agent = await createAgent({ provider: "xai", model: "grok-4.6", baseUrl: server.url.toString(), apiKey: "local-key", systemPrompt: "SYSTEM", cwd: root, storage, thinkingLevel: "off", memory: { store: memory }, contextWindow: 30000, maxTokens: 1000 });
	try {
		const events = [];
		for await (const event of agent.runTurn("CURRENT_USER_REQUIREMENT")) events.push(event);
		const request = JSON.stringify(requests[0]);
		expect(request).toContain("OLD_MEMORY_MARKER"); expect(request).toContain("CURRENT_USER_REQUIREMENT");
		expect(request).not.toContain("PRIVATE_TOPIC_BODY");
		expect(JSON.stringify(requests[0]?.input.filter(item => ["developer", "system"].includes((item as { role: string }).role)))).not.toContain("OLD_MEMORY_MARKER");
		expect(events).toContainEqual(expect.objectContaining({ type: "memory", phase: "projection", truncated: true }));
		expect(JSON.stringify(await storage.load())).not.toContain("OLD_MEMORY_MARKER");
		await writeFile(join(root, "MEMORY.md"), "NEW_MEMORY_MARKER\n[removed](detail.md)");
		await rm(join(root, "detail.md"));
		for await (const _event of agent.runTurn("A new task")) {}
		expect(JSON.stringify(requests[1])).toContain("NEW_MEMORY_MARKER");
		expect(JSON.stringify(requests[1])).not.toContain("OLD_MEMORY_MARKER");
		expect(JSON.stringify(requests[1])).toContain("unavailable");
	} finally { await agent.dispose(); server.stop(true); }
});

test("oversized pinned content is reported instead of silently truncated", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-pinned-")); directories.push(root);
	await writeFile(join(root, "large.md"), "PINNED_SENTINEL" + "x".repeat(15000));
	const store = new LongTermMemory({ project: root }); await store.pin("project", "large.md", true);
	const agent = await createAgent({ provider: "faux", model: "faux-1", cwd: root, systemPrompt: "", memory: { store } }, options => createPiTestPort({ ...options, responses: [{ text: "ok" }] }));
	try {
		const events = []; for await (const event of agent.runTurn("hello")) events.push(event);
		expect(events).toContainEqual(expect.objectContaining({ type: "memory", warnings: expect.arrayContaining([expect.stringContaining("Pinned memory project/large.md does not fit")]) }));
	} finally { await agent.dispose(); }
});

for (const mode of ["disabled", "budget", "permission", "hook"] as const) test(`memory ${mode} prevents writes without reporting a successful save`, async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-gate-")); directories.push(root);
	const store = new LongTermMemory({ project: root });
	const agent = await createAgent({ provider: "faux", model: "faux-1", cwd: root, systemPrompt: "", memory: { store, autoUpdate: mode !== "disabled", ...(mode === "budget" ? { maxWrites: 0 } : {}) },
		permission: { rules: [{ tool: "*", argsPattern: "*", effect: mode === "permission" ? "deny" : "allow" }] },
		...(mode === "hook" ? { toolHooks: { async beforeToolCall() { return { block: true, reason: "host blocked write" }; } } } : {}),
	}, options => createPiTestPort({ ...options, responses: [
		{ toolCalls: [{ id: "save", name: "write_memory", arguments: { scope: "project", path: "denied.md", content: "must not persist", expectedVersion: null } }] }, { text: "Main task complete; note not saved." },
	] }));
	try {
		const events = []; for await (const event of agent.runTurn("Save this")) events.push(event);
		expect(await store.list("project")).toEqual([]);
		expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", isError: true }));
	} finally { await agent.dispose(); }
});

test("memory failure remains a tool failure while session storage failure faults the SDK", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-fault-")); directories.push(root);
	const memory = new LongTermMemory({ project: root }), storage = new MemorySessionStorage();
	const originalAppend = storage.append.bind(storage);
	storage.append = async entry => { if (entry.type === "message" && entry.message.role === "toolResult") throw new Error("session commit failed"); await originalAppend(entry); };
	const agent = await createAgent({ provider: "faux", model: "faux-1", cwd: root, systemPrompt: "", storage, memory: { store: memory }, permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] } }, options => createPiTestPort({ ...options, responses: [{ toolCalls: [{ id: "save", name: "write_memory", arguments: { scope: "project", path: "saved.md", content: "file succeeded", expectedVersion: null } }] }] }));
	try {
		await expect((async () => { for await (const _event of agent.runTurn("remember")) {} })()).rejects.toThrow("session commit failed");
		expect((await memory.read("project", "saved.md")).text).toContain("file succeeded");
		expect(() => agent.runTurn("again")).toThrow("faulted");
	} finally { await agent.dispose(); }
});

test("dispose waits for an already-started memory write and canceled publication leaves no note", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-cancel-")); directories.push(root);
	let entered!: () => void, release!: () => void;
	const writing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	const store = new LongTermMemory({ project: root }, { ...fs, async writeFile(path, data, options) {
		if (String(data).startsWith("CANCEL_ME")) { entered(); await gate; }
		return fs.writeFile(path, data, options);
	} });
	const agent = await createAgent({ provider: "faux", model: "faux-1", cwd: root, systemPrompt: "", memory: { store }, permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] } }, options => createPiTestPort({ ...options, responses: [{ toolCalls: [{ id: "save", name: "write_memory", arguments: { scope: "project", path: "canceled.md", content: "CANCEL_ME", expectedVersion: null } }] }] }));
	const consumed = (async () => { for await (const _event of agent.runTurn("remember")) {} })();
	try {
		await writing;
		let disposed = false;
		const disposing = agent.dispose().then(() => { disposed = true; });
		await Bun.sleep(20); expect(disposed).toBe(false);
		release(); await disposing; await consumed;
		expect(await store.list("project")).toEqual([]);
	} finally { release(); await consumed; await agent.dispose(); }
});

test("same-turn requests drop pinned memory deleted by a host management operation", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-memory-refresh-")); directories.push(root);
	await writeFile(join(root, "pin.md"), "DELETED_PIN_BODY");
	const store = new LongTermMemory({ project: root }); await store.pin("project", "pin.md", true);
	const { modelResponse } = await import("./helpers/model-response.ts");
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return requests.length === 1 ? modelResponse([{ id: "delete", name: "host_cleanup", arguments: {} }]) : modelResponse(); } });
	const agent = await createAgent({ provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: server.url.toString(), apiKey: "local-key", systemPrompt: "", cwd: root, memory: { store }, permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] }, tools: [{ name: "host_cleanup", label: "cleanup", description: "Host operation", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { await rm(join(root, "pin.md")); return { content: [{ type: "text", text: "Cleanup complete" }], details: null }; } }] });
	try {
		for await (const _event of agent.runTurn("clean up")) {}
		expect(requests[0]).toContain("DELETED_PIN_BODY");
		expect(requests[1]).not.toContain("DELETED_PIN_BODY");
	} finally { await agent.dispose(); server.stop(true); }
});
