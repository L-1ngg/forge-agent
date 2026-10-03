import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { response } from "@forge-agent/protocol";
import { createAgent, LongTermMemory, SessionStore, type Agent, type ConfigurationReceipt } from "../src/sdk.ts";
import { loadConfig } from "../src/config.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import { createSummaryDriver } from "../src/session-configuration.ts";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";

interface Body {
	system?: Array<{ text: string }>;
	instructions?: string;
	messages?: unknown[];
	input?: unknown[];
	tools?: unknown[];
	prompt_cache_key?: string;
	cache_control?: unknown;
}
const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory() { const root = await mkdtemp(join(tmpdir(), "forge-prompt-cache-")); directories.push(root); return root; }
function fixture(reply: (body: Body, index: number) => Response) {
	const requests: Body[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as Body;
		requests.push(body); return reply(body, requests.length - 1);
	} });
	servers.push(server); return { requests, baseUrl: server.url.toString() };
}
function responses(text = "done", tool = false): Response {
	const output = tool
		? [{ type: "function_call", id: "fc-cache", call_id: "call-cache", name: "work", arguments: "{}", status: "completed" }]
		: [{ type: "message", id: "msg-cache", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
	return new Response([
		{ type: "response.created", response: { id: "resp-cache", status: "in_progress" } },
		{ type: "response.completed", response: { id: "resp-cache", status: "completed", output, usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020, input_tokens_details: { cached_tokens: 700 } } } },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function run(agent: Agent, input = "continue") {
	const turn = agent.runTurn(input);
	for await (const _ of turn) { }
	expect(await turn.result).toEqual({ status: "success" });
}
const work = { name: "work", label: "Work", description: "A synthetic no-op", parameters: { type: "object" as const, properties: {}, additionalProperties: false }, async execute() { return { content: [{ type: "text" as const, text: "done" }], details: {} }; } };
const allow = { hooks: [{ evaluate: () => ({ kind: "allow" as const, source: "hook" as const }) }] };
const base = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-cache-key", systemPrompt: "MAIN ORIGINAL", maxTokens: 512, retry: { enabled: false } };

for (const needsApproval of [false, true]) test(`HTTP prefix keeps main/skills before fresh memory through ${needsApproval ? "approval resumes" : "tool continuations"} and configuration changes`, async () => {
	const root = await directory(), memoryRoot = join(root, "memory"), skillsRoot = join(root, "skills");
	await mkdir(memoryRoot); await mkdir(join(skillsRoot, "cache-example"), { recursive: true });
	await writeFile(join(memoryRoot, "MEMORY.md"), "MEMORY ORIGINAL");
	await writeFile(join(skillsRoot, "cache-example", "SKILL.md"), "---\nname: cache-example\ndescription: Synthetic cache audit skill.\n---\nInspect synthetic examples.\n");
	const http = fixture((_body, index) => index < 2 ? modelResponse([{ id: `call-${index}`, name: "work", arguments: {} }]) : modelResponse());
	let update: ConfigurationReceipt | undefined, calls = 0;
	const agent = await createAgent({ ...base, cwd: root, baseUrl: http.baseUrl, permission: needsApproval ? {} : allow,
		skills: { roots: { workspace: { path: skillsRoot } } }, memory: { store: new LongTermMemory({ project: memoryRoot }), autoUpdate: false },
		tools: [{ ...work, async execute() {
			if (++calls === 1) update = await agent.updateConfiguration({ systemPrompt: "MAIN UPDATED", cacheHints: false });
			else if (calls === 2) update = await agent.updateConfiguration({ cacheHints: true });
			return work.execute();
		} }],
	});
	try {
		const running = run(agent);
		if (needsApproval) {
			const approvals = agent.requests[Symbol.asyncIterator]();
			for (let i = 0; i < 2; i++) {
				const pending = await approvals.next();
				if (pending.done || pending.value.kind !== "permission") throw new Error("Expected a permission request");
				expect(http.requests).toHaveLength(i + 1);
				expect(agent.respond(response(pending.value.id, { decision: "allow_once" }))).toBe(true);
			}
		}
		await running; expect(await update?.applied).toMatchObject({ status: "applied" });
		await run(agent, "same memory");
		await writeFile(join(memoryRoot, "MEMORY.md"), "MEMORY UPDATED");
		await run(agent, "new memory");
		expect(http.requests).toHaveLength(5); expect(calls).toBe(2);
		for (const [index, request] of http.requests.entries()) {
			expect(request.system).toHaveLength(3);
			expect(request.system?.[0]?.text).toBe(index === 0 ? "MAIN ORIGINAL" : "MAIN UPDATED");
			expect(request.system?.[1]?.text).toContain("cache-example");
			expect(request.system?.[2]?.text).toContain(index === 4 ? "MEMORY UPDATED" : "MEMORY ORIGINAL");
			expect(request.tools).toEqual(http.requests[0]!.tools);
			expect(request.cache_control).toEqual(index === 1 ? undefined : { type: "ephemeral" });
		}
		expect(http.requests[1]!.system).toEqual(http.requests[3]!.system);
		expect(http.requests[4]!.system?.slice(0, 2)).toEqual(http.requests[3]!.system?.slice(0, 2));
		for (let i = 1; i < http.requests.length; i++) {
			const previous = http.requests[i - 1]!.messages!;
			expect(http.requests[i]!.messages?.slice(0, previous.length)).toEqual(previous);
		}
	} finally { await agent.dispose(); }
});

test("xAI HTTP cache key survives tool continuation and JSONL reopen, and follows the cacheHints switch", async () => {
	const root = await directory(), path = join(root, "session.jsonl");
	const http = fixture((_body, index) => responses("done", index === 0));
	const options = { ...base, provider: "xai", model: "grok-4.6", baseUrl: http.baseUrl, cwd: root, sessionId: "stable-session", tools: [work], permission: allow };
	const first = await createAgent({ ...options, storage: await SessionStore.open(path, root) });
	try {
		await run(first); await run(first, "second input");
		expect(first.getUsage()).toMatchObject({ cacheReadTokens: 700, inputTokens: 300 });
	} finally { await first.dispose(); }
	const reopened = await createAgent({ ...options, storage: await SessionStore.open(path, root) });
	try {
		await run(reopened, "after reopen");
		await (await reopened.updateConfiguration({ cacheHints: false })).applied;
		await run(reopened, "disabled");
		await (await reopened.updateConfiguration({ cacheHints: true })).applied;
		await run(reopened, "enabled again");
	} finally { await reopened.dispose(); }
	const other = await createAgent({ ...options, sessionId: "other-session" });
	try { await run(other); } finally { await other.dispose(); }
	const key = http.requests[0]!.prompt_cache_key;
	expect(key).toBeString(); expect(key!.length).toBeGreaterThan(0); expect(key!.length).toBeLessThanOrEqual(64);
	for (const index of [1, 2, 3, 5]) expect(http.requests[index]!.prompt_cache_key).toBe(key);
	expect(http.requests[4]!.prompt_cache_key).toBeUndefined();
	expect(http.requests[6]!.prompt_cache_key).toBeString(); expect(http.requests[6]!.prompt_cache_key).not.toBe(key);
});

for (const provider of ["anthropic", "xai"] as const) test(`${provider} cache hints apply to tasks, not memory organizers or summaries`, async () => {
	const root = await directory();
	const http = fixture(body => {
		const system = body.instructions ?? body.system?.map(part => part.text).join("\n") ?? "";
		const text = system.startsWith("Maintain concise long-term Markdown memory.") ? '{"updates":[],"indexes":[]}' : "done";
		return provider === "anthropic" ? modelResponse([], "end_turn", text) : responses(text);
	});
	const options = { ...base, provider, model: provider === "xai" ? "grok-4.6" : base.model, cwd: root, baseUrl: http.baseUrl, sessionId: "auxiliary-cache" };
	const agent = await createAgent({ ...options, memory: { store: new LongTermMemory({ project: root }) } });
	try {
		await run(agent);
		await createSummaryDriver({ ...options, model: { ...getCatalogModel(provider, options.model)!, baseUrl: http.baseUrl }, thinkingLevel: "off", cacheHints: true }).summarize!({ prompt: "Synthetic summary input", maxTokens: 128, reasoning: "off" }, new AbortController().signal);
		expect(http.requests).toHaveLength(3);
		if (provider === "anthropic") expect(http.requests[0]!.cache_control).toEqual({ type: "ephemeral" });
		else expect(http.requests[0]!.prompt_cache_key).toBeString();
		for (const request of http.requests.slice(1)) {
			expect(request.cache_control).toBeUndefined(); expect(request.prompt_cache_key).toBeUndefined();
		}
		await (await agent.updateConfiguration({ cacheHints: false })).applied;
		await run(agent, "without hints");
		expect(http.requests[3]!.cache_control).toBeUndefined(); expect(http.requests[3]!.prompt_cache_key).toBeUndefined();
	} finally { await agent.dispose(); }
});

for (const spec of [{ provider: "openai", model: "gpt-5.4" }, { provider: "minimax", model: "MiniMax-M2.7" }]) test(`cache hints do not leak into ${spec.provider} requests`, async () => {
	const root = await directory(), model = getCatalogModel(spec.provider, spec.model)!;
	const http = fixture(() => model.api === "anthropic-messages" ? modelResponse() : responses());
	const agent = await createAgent({ ...base, ...spec, cwd: root, baseUrl: http.baseUrl, sessionId: "unrelated-provider", cacheHints: true });
	try { await run(agent); expect(http.requests[0]!.cache_control).toBeUndefined(); expect(http.requests[0]!.prompt_cache_key).toBeUndefined(); }
	finally { await agent.dispose(); }
});

test("cacheHints validates at SDK boundaries and project config overrides the global setting", async () => {
	const root = await directory();
	expect((await loadConfig({ cwd: root, home: root, env: {} })).cacheHints).toBe(true);
	await mkdir(join(root, ".forge-agent")); await mkdir(join(root, ".config", "forge-agent"), { recursive: true });
	await writeFile(join(root, ".config", "forge-agent", "config.json"), JSON.stringify({ cacheHints: false }));
	const config = () => loadConfig({ cwd: root, home: root, env: {} });
	expect((await config()).cacheHints).toBe(false);
	await writeFile(join(root, ".forge-agent", "config.json"), JSON.stringify({ cacheHints: true }));
	expect((await config()).cacheHints).toBe(true);
	await writeFile(join(root, ".forge-agent", "config.json"), JSON.stringify({ cacheHints: "false" }));
	await expect(config()).rejects.toThrow("cacheHints");
	const invalid = JSON.parse('{"cacheHints":"false"}');
	await expect(createAgent({ ...base, cwd: root, ...invalid })).rejects.toThrow("cacheHints");
	const http = fixture(() => modelResponse());
	const agent = await createAgent({ ...base, cwd: root, baseUrl: http.baseUrl });
	try {
		await expect(agent.updateConfiguration(invalid)).rejects.toThrow("cacheHints");
		await run(agent); expect(http.requests[0]!.cache_control).toEqual({ type: "ephemeral" });
	} finally { await agent.dispose(); }
});
