import type { SessionMessage, SessionEvent } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import { createAgent, MemorySessionStorage, type CreateAgentOptions } from "@forge-agent/core/sdk";
import { gate, modelResponse } from "./helpers/model-response.ts";

const options = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", systemPrompt: "task-system", cwd: process.cwd(), maxTokens: 512, contextWindow: 32000, context: { strategy: "adaptive", reserveTokens: 1024, keepRecentTokens: 100 } } satisfies CreateAgentOptions;
const msg = (role: "user" | "assistant", text: string): SessionMessage => ({ role, content: [{ type: "text", text }], timestamp: 1, ...(role === "assistant" ? { stopReason: "stop" } : {}) });

test("SDK restores sourced constraints after adaptive compaction without replacing raw history", async () => {
	const storage = new MemorySessionStorage([msg("user", "Do not deploy. Use port 8080."), msg("assistant", "Investigation ".repeat(1500)), msg("user", "Correction: use port 9090. Do not deploy. " + "unrelated background ".repeat(1000)), msg("assistant", "More investigation ".repeat(1500)), msg("user", "Continue debugging")]);
	const original = await storage.load();
	const first = original.entries[0]!.id, corrected = original.entries[2]!.id;
	const checkpoint = { states: [
		{ id: "port-old", kind: "decision", text: "Use port 8080.", status: "superseded", sources: [{ entryId: first, quote: "Use port 8080." }], supersedes: [] },
		{ id: "port-new", kind: "decision", text: "use port 9090.", status: "active", sources: [{ entryId: corrected, quote: "use port 9090." }], supersedes: ["port-old"] },
		{ id: "no-deploy", kind: "constraint", text: "Do not deploy.", status: "active", sources: [{ entryId: corrected, quote: "Do not deploy." }], supersedes: [] },
	], claims: [], taskChanged: false };
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.text(); requests.push(body);
		return body.includes("task-system") ? modelResponse() : modelResponse([], "end_turn", JSON.stringify(checkpoint));
	} });
	const settings = { ...options, baseUrl: server.url.toString(), storage };
	let agent = await createAgent(settings);
	try {
		expect((await agent.compact()).status).toBe("complete");
		expect((await storage.load()).entries.slice(0, original.entries.length)).toEqual(original.entries);
		await agent.dispose(); agent = await createAgent(settings);
		for await (const _event of agent.runTurn("Proceed")) { }
		const task = requests.at(-1)!;
		expect(task).toContain("Do not deploy."); expect(task).toContain("9090");
		expect(task).not.toContain("8080"); expect(task).not.toContain("Investigation Investigation");
	} finally { await agent.dispose(); server.stop(true); }
});

test("adaptive rejects oversized summary input before sending any request", async () => {
	const storage = new MemorySessionStorage([msg("user", "keep constraint"), msg("assistant", "huge ".repeat(20000)), msg("user", "Continue")]);
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse(); } });
	const agent = await createAgent({ ...options, contextWindow: 8000, storage, baseUrl: server.url.toString() });
	try { const result = await agent.compact(); expect(result.status).toBe("error"); expect(result.error).toBe("summary_input_budget_exceeded"); expect(requests).toBe(0); }
	finally { await agent.dispose(); server.stop(true); }
});

test("adaptive clips recoverable old tool output with zero summary calls", async () => {
	const history: SessionMessage[] = [msg("user", "Inspect build"), { role: "assistant", timestamp: 2, stopReason: "tool_use", content: [{ type: "tool_call", id: "build", name: "read", arguments: { path: "build.log" } }] }, { role: "toolResult", toolCallId: "build", toolName: "read", timestamp: 3, content: [{ type: "text", text: "Build detail ".repeat(4000) }] }, msg("user", "What next?")];
	const storage = new MemorySessionStorage(history); let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse(); } });
	const agent = await createAgent({ ...options, context: { ...options.context, keepRecentTokens: 2000 }, storage, baseUrl: server.url.toString() });
	try { const events: SessionEvent[] = []; const result = await agent.compact(undefined, event => events.push(event)); expect(result.status).toBe("complete"); expect(requests).toBe(0); expect(result.afterTokens).toBeLessThan(result.beforeTokens); }
	finally { await agent.dispose(); server.stop(true); }
});

test.each(["missing", "foreign", "denied"] as const)("context retrieval respects %s access boundaries", async mode => {
	const storage = new MemorySessionStorage([msg("user", "PRIVATE-BRANCH-EVIDENCE")]);
	const initial = await storage.load();
	if (mode === "foreign") { initial.leafId = null; }
	const selected = new MemorySessionStorage(initial);
	const results: SessionMessage[] = []; let tasks = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++tasks === 1 ? modelResponse([{ id: "lookup", name: "read_context", arguments: { entryId: mode === "missing" ? "missing" : initial.entries[0]!.id } }]) : modelResponse(); } });
	const agent = await createAgent({ ...options, storage: selected, baseUrl: server.url.toString(), permission: { rules: [{ tool: "read_context", argsPattern: "*", effect: mode === "denied" ? "deny" : "allow" }] } });
	try {
		for await (const event of agent.runTurn("Look up evidence")) if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
		expect(results).toHaveLength(1); expect(results[0]!.isError).toBe(true); expect(JSON.stringify(results[0]!.content)).not.toContain("PRIVATE-BRANCH-EVIDENCE");
	} finally { await agent.dispose(); server.stop(true); }
});

test("SDK rejects fabricated checkpoint evidence without changing saved history", async () => {
	const storage = new MemorySessionStorage([msg("user", "Do not deploy."), msg("assistant", "notes ".repeat(3000)), msg("user", "Continue")]);
	const before = await storage.load(); let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse([], "end_turn", JSON.stringify({ states: [{ id: "lie", kind: "constraint", text: "Deploy", status: "active", sources: [{ entryId: before.entries[0]!.id, quote: "Deploy now" }], supersedes: [] }], claims: [], taskChanged: false })); } });
	const agent = await createAgent({ ...options, storage, baseUrl: server.url.toString() });
	try { expect((await agent.compact()).status).toBe("error"); expect(requests).toBe(2); expect(await storage.load()).toEqual(before); }
	finally { await agent.dispose(); server.stop(true); }
});

test("SDK reads Unicode at the end of a saved long single line through the authorized context tool", async () => {
	const storage = new MemorySessionStorage([msg("user", "😀".repeat(5000) + "END-证据"), msg("assistant", "Ready")]);
	const id = (await storage.load()).entries[0]!.id; const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests.push(await request.text()); return requests.length === 1 ? modelResponse([{ id: "read-1", name: "read_context", arguments: { entryId: id, offset: 4999, limit: 20 } }]) : modelResponse();
	} });
	const agent = await createAgent({ ...options, context: { ...options.context, enabled: false }, storage, baseUrl: server.url.toString(), permission: { rules: [{ tool: "read_context", argsPattern: "*", effect: "allow" }] } });
	try {
		const results = [];
		for await (const event of agent.runTurn("Find the saved evidence")) if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).not.toBe(true);
		expect(results[0]!.content).toEqual([{ type: "text", text: JSON.stringify({ entryId: id, role: "user", isError: false, text: "😀END-证据" }) }]);
		expect(requests[0]).toContain('"name":"read_context"');
		expect(requests[1]).toContain("😀END-证据");
	} finally { await agent.dispose(); server.stop(true); }
});

test("SDK retains constraints across five incremental compactions and rebuilds from original evidence", async () => {
	const storage = new MemorySessionStorage([msg("user", "Do not deploy."), msg("assistant", "initial notes ".repeat(1200)), msg("user", "checkpoint now")]);
	const id = (await storage.load()).entries[0]!.id;
	const checkpoint = { states: [{ id: "constraint", kind: "constraint", text: "Do not deploy.", status: "active", sources: [{ entryId: id, quote: "Do not deploy." }], supersedes: [] }], claims: [], taskChanged: false };
	let summaries = 0; const events: SessionEvent[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.text();
		if (!body.includes("task-system")) { summaries++; return modelResponse([], "end_turn", JSON.stringify(checkpoint)); }
		return modelResponse([], "end_turn", body.includes("GENERATE-NOTES") ? "new notes ".repeat(1600) : "done");
	} });
	let agent = await createAgent({ ...options, storage, baseUrl: server.url.toString() });
	try {
		for (let i = 0; i < 5; i++) {
			if (i) {
				for await (const _event of agent.runTurn(`GENERATE-NOTES ${i}`)) { }
				// The latest work stays verbatim; provide a new user boundary without another task call.
				const state = await storage.load();
				await storage.append({ type: "message", id: `boundary-${i}`, parentId: state.leafId, timestamp: new Date().toISOString(), message: msg("user", "checkpoint now") });
				await agent.dispose();
				agent = await createAgent({ ...options, storage, baseUrl: server.url.toString() });
			}
			expect((await agent.compact(undefined, event => events.push(event))).status).toBe("complete");
		}
		expect(summaries).toBeGreaterThanOrEqual(5);
		expect(events.filter(event => event.type === "compaction" && event.phase === "end").map(event => event.type === "compaction" ? event.action : "")).toEqual(["rebuild", "summary", "summary", "summary", "rebuild"]);
	} finally { await agent.dispose(); server.stop(true); }
});

test("oversized protected context stops automatic task dispatch instead of looping", async () => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return modelResponse(); } });
	const agent = await createAgent({ ...options, contextWindow: 2000, baseUrl: server.url.toString() });
	try {
		const turn = agent.runTurn("Critical constraint ".repeat(2000)); for await (const _event of turn) { }
		expect((await turn.result).status).toBe("error"); expect(requests).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});

test("canceling an adaptive summary leaves the previous persisted view intact", async () => {
	const storage = new MemorySessionStorage([msg("user", "Do not deploy"), msg("assistant", "notes ".repeat(3000)), msg("user", "continue")]);
	const before = await storage.load(), started = gate(), release = gate(); let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { calls++; started.resolve(); await release.promise; return modelResponse(); } });
	const agent = await createAgent({ ...options, storage, baseUrl: server.url.toString() });
	try { const pending = agent.compact(); await started.promise; agent.abort(); release.resolve(); expect((await pending).status).toBe("error"); expect(calls).toBe(1); expect(await storage.load()).toEqual(before); }
	finally { release.resolve(); await agent.dispose(); server.stop(true); }
});

test("adaptive enforces a shared four-request cap including retries", async () => {
	const storage = new MemorySessionStorage([msg("user", "constraint"), msg("assistant", "notes ".repeat(3000)), msg("user", "continue")]);
	let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }), { status: 529 }); } });
	const agent = await createAgent({ ...options, storage, retry: { maxRetries: 20, baseDelayMs: 0 }, baseUrl: server.url.toString() });
	try { expect((await agent.compact()).status).toBe("error"); expect(calls).toBe(4); }
	finally { await agent.dispose(); server.stop(true); }
});

test("one SDK invocation compresses completed tool batches without replaying side effects", async () => {
	let tasks = 0, summaries = 0, effects = 0, compactions = 0;
	const storage = new MemorySessionStorage();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.text();
		if (!body.includes("task-system")) { summaries++; const source = (await storage.load()).entries[0]!; return modelResponse([], "end_turn", JSON.stringify({ states: [{ id: "goal", kind: "goal", text: "Inspect all parts", status: "active", sources: [{ entryId: source.id, quote: "Inspect all parts" }], supersedes: [] }], claims: [], taskChanged: false })); }
		tasks++; return tasks <= 5 ? modelResponse([{ id: `work-${tasks}`, name: "inspect", arguments: {} }]) : modelResponse();
	} });
	const agent = await createAgent({ ...options, contextWindow: 10000, storage, baseUrl: server.url.toString(), tools: [{ name: "inspect", label: "Inspect", description: "inspect", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { effects++; return { content: [{ type: "text", text: "detail ".repeat(1700) }], details: {} }; } }], permission: { rules: [{ tool: "inspect", argsPattern: "*", effect: "allow" }] } });
	try { const turn = agent.runTurn("Inspect all parts"); for await (const event of turn) if (event.type === "compaction" && event.phase === "end") compactions++; expect((await turn.result).status).toBe("success"); expect(effects).toBe(5); expect(tasks).toBe(6); expect(compactions).toBeGreaterThan(0); expect(summaries).toBe(0); }
	finally { await agent.dispose(); server.stop(true); }
});

test("switching from pi to adaptive restores original history before the next task", async () => {
	const storage = new MemorySessionStorage([msg("user", "Unabridged constraint: use 9090"), msg("assistant", "notes ".repeat(3000)), msg("user", "Continue")]);
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	const agent = await createAgent({ ...options, context: { ...options.context, strategy: "pi" }, storage, baseUrl: server.url.toString() });
	try { expect((await agent.compact()).status).toBe("complete"); agent.configureContext({ strategy: "adaptive" }); for await (const _event of agent.runTurn("Continue")) { } expect(requests.at(-1)).toContain("Unabridged constraint: use 9090"); }
	finally { await agent.dispose(); server.stop(true); }
});

test.each(["removed", "rewritten", "version"] as const)("reopening rejects %s persisted task state", async mode => {
	const storage = new MemorySessionStorage([msg("user", "Do not deploy."), msg("assistant", "notes ".repeat(3000)), msg("user", "continue")]);
	const source = (await storage.load()).entries[0]!.id;
	const checkpoint = { states: [{ id: "rule", kind: "constraint", text: "Do not deploy.", status: "active", sources: [{ entryId: source, quote: "Do not deploy." }], supersedes: [] }], claims: [], taskChanged: false };
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return modelResponse([], "end_turn", JSON.stringify(checkpoint)); } });
	const settings = { ...options, storage, baseUrl: server.url.toString() };
	const agent = await createAgent(settings);
	try {
		expect((await agent.compact()).status).toBe("complete"); await agent.dispose();
		const saved = await storage.load(); const latest = saved.entries.at(-1)!;
		if (latest.type !== "compaction" || !latest.adaptive) throw new Error("Expected adaptive checkpoint");
		const broken = structuredClone(latest); broken.id = "broken"; broken.parentId = latest.id;
		if (mode === "removed") broken.adaptive!.states = [];
		else if (mode === "rewritten") broken.adaptive!.states[0]!.text = "Deploy now";
		else Object.assign(broken.adaptive!, { version: 999 });
		await storage.append(broken);
		await expect(createAgent(settings)).rejects.toThrow(mode === "version" ? "version" : "silently");
	} finally { await agent.dispose(); server.stop(true); }
});

test("identical assistant text with different timestamps is deduplicated without a summary request", async () => {
	const first = msg("assistant", "repeated observation ".repeat(400));
	const storage = new MemorySessionStorage([msg("user", "Keep the original requirements"), first, { ...first, timestamp: 5000 }, msg("user", "Continue")]);
	let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return modelResponse(); } });
	const agent = await createAgent({ ...options, context: { ...options.context, keepRecentTokens: 20000 }, storage, baseUrl: server.url.toString() });
	try { expect((await agent.compact()).status).toBe("complete"); expect(calls).toBe(0); }
	finally { await agent.dispose(); server.stop(true); }
});

test("adaptive reserves provider thinking tokens before dispatch", async () => {
	let calls = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return modelResponse(); } });
	const agent = await createAgent({ ...options, contextWindow: 11000, thinkingLevel: "medium", baseUrl: server.url.toString() });
	try {
		const turn = agent.runTurn("important input ".repeat(800)); for await (const _event of turn) { }
		expect((await turn.result).status).toBe("error"); expect(calls).toBe(0);
	} finally { await agent.dispose(); server.stop(true); }
});


test("short checkpoint survives reopen while full source quotes remain retrievable", async () => {
	const quote = "Do not deploy. " + "evidence detail ".repeat(200);
	const storage = new MemorySessionStorage([msg("user", quote), msg("assistant", "notes ".repeat(3000)), msg("user", "Continue")]);
	const source = (await storage.load()).entries[0]!.id;
	const checkpoint = { states: [{ id: "rule", kind: "constraint", text: "Do not deploy.", status: "active", sources: [{ entryId: source, quote }], supersedes: [] }], claims: [], taskChanged: false };
	const requests: string[] = []; let tasks = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.text();
		if (!body.includes("task-system")) return modelResponse([], "end_turn", JSON.stringify(checkpoint));
		requests.push(body);
		return ++tasks === 1 ? modelResponse([{ id: "source-read", name: "read_context", arguments: { entryId: source } }]) : modelResponse();
	} });
	const settings = { ...options, storage, baseUrl: server.url.toString(), permission: { rules: [{ tool: "read_context", argsPattern: "*", effect: "allow" as const }] } };
	let agent = await createAgent(settings);
	try {
		expect((await agent.compact()).status).toBe("complete");
		const persisted = JSON.stringify(await storage.load()); expect(persisted).toContain(quote);
		await agent.dispose(); agent = await createAgent(settings);
		for await (const _event of agent.runTurn("Verify the constraint")) { }
		expect(requests[0]).toContain("Do not deploy."); expect(requests[0]).toContain(source);
		expect(requests[0]).not.toContain("evidence detail evidence detail");
		expect(requests[1]).toContain("evidence detail evidence detail");
	} finally { await agent.dispose(); server.stop(true); }
});

test("search finds the latest Chinese correction and returns a Unicode read offset", async () => {
	const storage = new MemorySessionStorage([msg("user", "端口设为8080"), msg("assistant", "端口只是猜测"), msg("user", "😀".repeat(600) + "纠正：端口改为9090。"), msg("user", "Continue")]);
	const correction = (await storage.load()).entries[2]!.id;
	let tasks = 0; const results: Array<Record<string, unknown>> = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
		return ++tasks === 1 ? modelResponse([{ id: "search", name: "search_context", arguments: { query: "端口", role: "user", limit: 1 } }]) : tasks === 2 ? modelResponse([{ id: "read", name: "read_context", arguments: { entryId: correction, offset: Number(results[0]?.matches && (results[0].matches as Array<{ offset: number }>)[0]?.offset), limit: 256 } }]) : modelResponse();
	} });
	const agent = await createAgent({ ...options, context: { ...options.context, enabled: false }, storage, baseUrl: server.url.toString(), permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] } });
	try {
		for await (const event of agent.runTurn("Find the latest decision")) if (event.type === "message_end" && event.message.role === "toolResult") {
			expect(event.message.isError).not.toBe(true);
			const text = event.message.content.find(block => block.type === "text"); if (text?.type === "text") results.push(JSON.parse(text.text));
		}
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ hasMore: true, matches: [{ entryId: correction, role: "user", isError: false }] });
		expect(results[1]?.text).toContain("纠正：端口改为9090。");
	} finally { await agent.dispose(); server.stop(true); }
});

test.each(["foreign", "denied", "no-match"] as const)("search preserves %s boundaries", async mode => {
	const initialStorage = new MemorySessionStorage([msg("user", "PRIVATE-SAVED-NEEDLE")]);
	const initial = await initialStorage.load(); if (mode === "foreign") initial.leafId = null;
	const storage = new MemorySessionStorage(initial); let tasks = 0;
	const results: SessionMessage[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++tasks === 1 ? modelResponse([{ id: "search", name: "search_context", arguments: { query: mode === "no-match" ? "missing-value" : "PRIVATE-SAVED-NEEDLE" } }]) : modelResponse(); } });
	const agent = await createAgent({ ...options, storage, baseUrl: server.url.toString(), permission: { rules: [{ tool: "search_context", argsPattern: "*", effect: mode === "denied" ? "deny" : "allow" }] } });
	try {
		for await (const event of agent.runTurn("Find earlier evidence")) if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
		expect(results).toHaveLength(1);
		if (mode === "denied") expect(results[0]!.isError).toBe(true);
		else expect(results[0]!.content).toEqual([{ type: "text", text: JSON.stringify({ matches: [], hasMore: false }) }]);
		expect(JSON.stringify(results[0]!.content)).not.toContain("PRIVATE-SAVED-NEEDLE");
	} finally { await agent.dispose(); server.stop(true); }
});

test("search uses literal words, case folding, error status and bounded previews", async () => {
	const history: SessionMessage[] = [];
	for (let i = 0; i < 12; i++) {
		history.push({ role: "assistant", timestamp: i, content: [{ type: "tool_call", id: `c-${i}`, name: "inspect", arguments: {} }] });
		history.push({ role: "toolResult", timestamp: i, toolCallId: `c-${i}`, toolName: "inspect", isError: true, content: [{ type: "text", text: "İ😀".repeat(200) + "ERROR [a+b] " + "长".repeat(400) }] });
	}
	const storage = new MemorySessionStorage(history); let tasks = 0; const results: SessionMessage[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++tasks === 1 ? modelResponse([{ id: "search", name: "search_context", arguments: { query: "error [a+b]", role: "toolResult", limit: 10 } }]) : modelResponse(); } });
	const agent = await createAgent({ ...options, context: { ...options.context, enabled: false }, storage, baseUrl: server.url.toString(), permission: { rules: [{ tool: "search_context", argsPattern: "*", effect: "allow" }] } });
	try {
		for await (const event of agent.runTurn("Find errors")) if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
		const block = results[0]!.content[0]!; if (block.type !== "text") throw new Error("Expected text");
		const result = JSON.parse(block.text) as { matches: Array<{ text: string; offset: number; isError: boolean }>; hasMore: boolean };
		expect(result.hasMore).toBe(true); expect(result.matches).toHaveLength(10);
		for (const match of result.matches) { expect(match.isError).toBe(true); expect(match.offset).toBe(336); expect([...match.text]).toHaveLength(256); expect(match.text).toContain("ERROR [a+b]"); }
	} finally { await agent.dispose(); server.stop(true); }
});

test.each([{ query: " " }, { query: "x".repeat(201) }, { query: "one two three four five six seven eight nine" }, { query: "valid", limit: 11 }])("invalid search input is rejected: %j", async args => {
	let tasks = 0; const results: SessionMessage[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return ++tasks === 1 ? modelResponse([{ id: "search", name: "search_context", arguments: args }]) : modelResponse(); } });
	const agent = await createAgent({ ...options, baseUrl: server.url.toString(), permission: { rules: [{ tool: "search_context", argsPattern: "*", effect: "allow" }] } });
	try {
		for await (const event of agent.runTurn("Search history")) if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
		expect(results).toHaveLength(1); expect(results[0]!.isError).toBe(true);
	} finally { await agent.dispose(); server.stop(true); }
});

test("search tool conflicts are atomic across creation, strategy and configuration updates", async () => {
	const tool = { name: "search_context", label: "Host search", description: "Host-owned search", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const }, async execute() { return { content: [], details: {} }; } };
	await expect(createAgent({ ...options, tools: [tool] })).rejects.toThrow("reserved");
	const pi = await createAgent({ ...options, context: { ...options.context, strategy: "pi" }, tools: [tool] });
	try { expect(() => pi.configureContext({ strategy: "adaptive" })).toThrow("reserved"); }
	finally { await pi.dispose(); }
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests.push(await request.text()); return modelResponse(); } });
	const agent = await createAgent({ ...options, baseUrl: server.url.toString() });
	try {
		await expect(agent.updateConfiguration({ tools: [tool], systemPrompt: "must not apply" })).rejects.toThrow("reserved");
		for await (const _event of agent.runTurn("Continue")) { }
		expect(requests[0]).toContain("task-system"); expect(requests[0]).not.toContain("must not apply"); expect(requests[0]).not.toContain("Host-owned search");
	} finally { await agent.dispose(); server.stop(true); }
});
