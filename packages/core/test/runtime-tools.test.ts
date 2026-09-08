import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@forge-agent/core/sdk";
import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage } from "@forge-agent/core/sdk";
import { response } from "@forge-agent/protocol";
import { modelResponse, gate } from "./helpers/model-response.ts";
import type { HarnessTool } from "@forge-agent/tools";
const settings = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", systemPrompt: "tools", cwd: process.cwd() };
const parameters = { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false as const };
for (const scenario of ["allow", "mixed", "deny", "invalid", "unknown", "throw", "hook-block", "terminate", "sequential"] as const) test(`SDK native scheduling: ${scenario}`, async () => {
	let requests = 0;
	const effects: string[] = []; const after: string[] = []; const saved: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, fetch() {
			if (++requests > 1) return modelResponse();
			return modelResponse(["a", "b"].map(id => ({ id, name: scenario === "unknown" ? "missing" : "work", arguments: scenario === "invalid" ? {} : { id } })));
		}
	});
	const tool: HarnessTool<object, unknown> = {
		name: "work", label: "Work", description: "work", parameters,
		...(scenario === "sequential" ? { executionMode: "sequential" } : {}),
		async execute(input) { const { id } = input as { id: string }; effects.push(id); if (scenario === "throw") throw new Error("tool failed"); return { content: [{ type: "text", text: id }], details: id }; },
	};
	const storage = new MemorySessionStorage();
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), tools: [tool],
		storage: { load: () => storage.load(), async append(entry) { if (entry.type === "message" && entry.message.role === "toolResult") saved.push(entry.message.toolCallId!); await storage.append(entry); } },
		toolHooks: {
			beforeToolCall: async () => scenario === "hook-block" ? { block: true, reason: "blocked", terminate: true } : undefined,
			afterToolCall: async ({ toolCall }) => { after.push(toolCall.id); return scenario === "terminate" ? { terminate: true } : undefined; },
		},
	});
	const permissions = (async () => {
		for await (const request of agent.requests) {
			if (request.kind !== "permission") throw new Error("Unexpected request");
			const allow = scenario !== "deny" && !(scenario === "mixed" && effects.length === 0 && request.payload.toolCall.id === "a");
			agent.respond(response(request.id, allow ? { decision: "allow_once" } : { decision: "deny", reason: "test denied" }));
		}
	})();
	try {
		for await (const _event of agent.runTurn("work")) { }
		expect(saved).toEqual(["a", "b"]);
		if (["invalid", "unknown", "deny", "hook-block"].includes(scenario)) { expect(effects).toEqual([]); expect(after).toEqual([]); }
		else if (scenario === "mixed") expect(effects).toEqual(["b"]);
		else expect(effects).toEqual(["a", "b"]);
		expect(requests).toBe(["deny", "hook-block", "terminate"].includes(scenario) ? 1 : 2);
	} finally { await agent.dispose(); await permissions; server.stop(true); }
});

for (const failAt of ["assistant", "toolResult"] as const) test(`SDK ${failAt} save failure blocks later effects and settles tools`, async () => {
	let requests = 0; let effects = 0; let writes = 0;
	const started = gate(); const release = gate();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse(["a", "b"].map(id => ({ id, name: "work", arguments: { id } }))); } });
	const storage = new MemorySessionStorage();
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		tools: [{ name: "work", label: "Work", description: "work", parameters, async execute() { effects++; started.resolve(); await release.promise; return { content: [{ type: "text", text: "done" }], details: "done" }; } }],
		storage: { load: () => storage.load(), async append(entry) { writes++; if (entry.type === "message" && entry.message.role === failAt) throw new Error("disk failed"); await storage.append(entry); } },
	});
	const run = (async () => { for await (const _event of agent.runTurn("work")) { } })().catch(error => error as Error);
	try {
		if (failAt === "toolResult") { await started.promise; await Promise.resolve(); release.resolve(); }
		const error = await run; expect(error?.message).toBe("disk failed");
		expect(requests).toBe(1); expect(effects).toBe(failAt === "assistant" ? 0 : 2); expect(writes).toBe(failAt === "assistant" ? 2 : 3);
		expect(() => agent.runTurn("again")).toThrow("faulted");
	} finally { release.resolve(); await run; await agent.dispose(); server.stop(true); }
});

test("SDK native image, details and progress survive storage without leaking display data to the model", async () => {
	const requests: unknown[] = [];
	let lateUpdate: (() => void) | undefined;
	const directory = await mkdtemp(join(tmpdir(), "forge-native-result-"));
	const path = join(directory, "session.jsonl");
	const storage = await SessionStore.open(path, directory);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.json()); return requests.length === 1 ? modelResponse([{ id: "image", name: "picture", arguments: {} }]) : modelResponse(); } });
	const options = { ...settings, baseUrl: server.url.toString(), storage, permission: { hooks: [{ evaluate: () => ({ kind: "allow" as const, source: "hook" as const }) }] } };
	const agent = await createAgent({
		...options, tools: [{
			name: "picture", label: "Picture", description: "image", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute(_input, context) {
				const update = () => context.onUpdate?.({ content: [{ type: "text", text: "working" }], details: { private: "progress-only" } });
				update(); lateUpdate = update;
				return { content: [{ type: "text", text: "model-visible" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], details: { private: "display-only" } };
			},
		}]
	});
	try {
		const events = [];
		for await (const event of agent.runTurn("image")) { events.push(event); if (event.type === "tool_execution_end") lateUpdate?.(); }
		expect(events.filter(event => event.type === "tool_execution_update")).toHaveLength(1);
		expect(events.filter(event => event.type === "message_end" && event.message.role === "toolResult")).toHaveLength(1);
		expect(JSON.stringify(requests[1])).toContain('"type":"image"');
		expect(JSON.stringify(requests[1])).toContain("model-visible");
		expect(JSON.stringify(requests[1])).not.toContain("display-only");
		expect(JSON.stringify(requests[1])).not.toContain("progress-only");
		const saved = await storage.load(); expect(JSON.stringify(saved)).toContain("display-only");
		await agent.dispose();
		const reopenedStorage = await SessionStore.open(path, directory);
		expect(await reopenedStorage.load()).toEqual(saved);
		const reopened = await createAgent({ ...options, storage: reopenedStorage });
		try { for await (const _event of reopened.runTurn("remember")) { } expect(JSON.stringify(requests[2])).toContain('"type":"image"'); expect(JSON.stringify(requests[2])).not.toContain("display-only"); }
		finally { await reopened.dispose(); }
	} finally { await agent.dispose(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

for (const invalidAt of ["execute", "after"] as const) test(`SDK rejects nonpersistent ${invalidAt} results and waits for sibling effects`, async () => {
	const started = gate(); const release = gate(); let completed = false; let requests = 0;
	const storage = new MemorySessionStorage();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++requests === 1 ? modelResponse(["bad", "slow"].map(id => ({ id, name: "work", arguments: { id } }))) : modelResponse(); } });
	const agent = await createAgent({
		...settings, baseUrl: server.url.toString(), storage,
		permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
		...(invalidAt === "after" ? { toolHooks: { afterToolCall: async ({ toolCall }: { toolCall: { id: string } }) => toolCall.id === "bad" ? { details: 1n } : undefined } } : {}),
		tools: [{
			name: "work", label: "Work", description: "work", parameters, async execute(_input, context) {
				if (context.toolCallId === "slow") { started.resolve(); await release.promise; completed = true; }
				return { content: [{ type: "text", text: "done" }], details: context.toolCallId === "bad" && invalidAt === "execute" ? 1n : {} };
			}
		}],
	});
	let ended = false;
	const run = (async () => { for await (const _event of agent.runTurn("work")) { } ended = true; })();
	try {
		await started.promise; await Promise.resolve(); expect(ended).toBe(false);
		release.resolve(); await run; expect(completed).toBe(true); expect(requests).toBe(2);
		const messages = (await storage.load()).entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(messages.map(message => message.toolCallId)).toEqual(["bad", "slow"]);
		expect(messages[0]?.isError).toBe(true); expect(messages[1]?.isError).toBe(false);
	} finally { release.resolve(); await run; await agent.dispose(); server.stop(true); }
});

test("SDK assistant persistence barrier prevents tool effects while its write is pending", async () => {
 const saving = gate(); const release = gate(); let effects = 0; let requests = 0;
 const storage = new MemorySessionStorage();
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++requests === 1 ? modelResponse([{ id: "once", name: "work", arguments: { id: "once" } }]) : modelResponse(); } });
 const agent = await createAgent({ ...settings, baseUrl: server.url.toString(),
  permission: { hooks: [{ evaluate: () => ({ kind: "allow", source: "hook" }) }] },
  storage: { load: () => storage.load(), async append(entry) {
   if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "tool_use") { saving.resolve(); await release.promise; }
   await storage.append(entry);
  } },
  tools: [{ name: "work", label: "Work", description: "work", parameters, async execute() { effects++; return { content: [], details: {} }; } }],
 });
 const running = (async () => { for await (const _event of agent.runTurn("work")) {} })();
 try {
  await saving.promise; await Bun.sleep(20);
  expect(effects).toBe(0); expect(requests).toBe(1);
  release.resolve(); await running;
  expect(effects).toBe(1); expect(requests).toBe(2);
 } finally { release.resolve(); await running; await agent.dispose(); server.stop(true); }
});
