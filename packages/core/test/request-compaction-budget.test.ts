import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { createAgent, LongTermMemory, MemorySessionStorage, type AgentTurn, type Model } from "../src/sdk.ts";
import { SUMMARY_SYSTEM } from "../src/context/compaction.ts";
import { nativeAdapter, responseChunks } from "./helpers/native-adapter.ts";
import { withScenario } from "../../../tests/support/scenario.ts";

const model: Model<string> = { id: "budget-fixture", name: "Budget fixture", api: "faux", provider: "host", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (role: "user" | "assistant", text: string): SessionMessage => ({ role, timestamp: 1, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop" as const } : {}) });
const longHistory = () => [message("user", "Earlier discussion"), message("assistant", "Old investigation. ".repeat(460))];
const answer = message("assistant", "done");
const checkpoint = message("assistant", JSON.stringify({ states: [], claims: [], taskChanged: false }));
async function consume(turn: AgentTurn) { const events: SessionEvent[] = []; for await (const event of turn) events.push(event); return { events, result: await turn.result }; }

test("Memory recall crosses the soft line before the task request and uses the same fixed material in compaction", () => withScenario("memory-compaction-budget", async scenario => {
	const memoryRoot = join(scenario.directory, "memory");
	await mkdir(memoryRoot);
	await writeFile(join(memoryRoot, "MEMORY.md"), "Remember this project detail. ".repeat(155));
	const history = longHistory();
	const store = new LongTermMemory({ project: memoryRoot });
	const options = { cwd: scenario.cwd, systemPrompt: "BASE", model, maxTokens: 512, contextWindow: 8000, context: { enabled: true, reserveTokens: 4000, keepRecentTokens: 100 }, retry: { enabled: false }, memory: { store, autoUpdate: false } } as const;
	const run = async (memory: boolean, enabled: boolean) => {
		let taskCalls = 0, usageAtRequest: number | undefined;
		const storage = new MemorySessionStorage(history);
		const { memory: memoryOption, ...baseOptions } = options;
		const agent = await createAgent({ ...baseOptions, ...(memory ? { memory: memoryOption } : {}), storage, context: { ...options.context, enabled }, adapter: nativeAdapter(model, async function* (request) {
			if (JSON.stringify(request.systemPrompts).includes(SUMMARY_SYSTEM)) yield* responseChunks(checkpoint);
			else { taskCalls++; usageAtRequest = agent.getUsage()?.contextTokens; yield* responseChunks(answer); }
		}) });
		try { return { ...await consume(agent.runTurn("Continue")), taskCalls, usageAtRequest, storage }; }
		finally { await agent.dispose(); }
	};
	const withoutMemory = await run(false, true);
	const withoutCompaction = await run(true, false);
	const compacted = await run(true, true);
	expect(withoutMemory.result.status).toBe("success");
	expect(withoutMemory.events.some(event => event.type === "compaction")).toBe(false);
	expect(withoutMemory.usageAtRequest).toBeLessThanOrEqual(4000);
	expect(withoutCompaction.result.status).toBe("success");
	expect(withoutCompaction.usageAtRequest).toBeGreaterThan(4000);
	expect(compacted.result.status).toBe("success");
	const end = compacted.events.find(event => event.type === "compaction" && event.phase === "end");
	expect(end).toMatchObject({ type: "compaction", phase: "end", reason: "threshold", beforeTokens: withoutCompaction.usageAtRequest, afterTokens: compacted.usageAtRequest });
	expect(compacted.taskCalls).toBe(1);
	expect((await compacted.storage.load()).entries.some(entry => entry.type === "compaction" && entry.checkpoint)).toBe(true);
}));

test("Skills catalog and native tool schemas drive the same automatic selection and host ordering", () => withScenario("skills-compaction-budget", async scenario => {
	const root = join(scenario.directory, "skills");
	for (let index = 0; index < 8; index++) {
		const skill = join(root, `guide-${index}`);
		await mkdir(skill, { recursive: true });
		await writeFile(join(skill, "SKILL.md"), `---\nname: guide-${index}\ndescription: ${"A useful project workflow. ".repeat(33)}\n---\nFull instructions.`);
	}
	const history = longHistory();
	const options = { cwd: scenario.cwd, systemPrompt: "BASE", model, maxTokens: 512, contextWindow: 8000, context: { enabled: true, reserveTokens: 4000, keepRecentTokens: 100 }, retry: { enabled: false }, skills: { roots: { workspace: { path: root } } } } as const;
	const run = async (enabled: boolean) => {
		const order: string[] = [];
		let usageAtRequest: number | undefined, fixedTokens: number | undefined;
		const agent = await createAgent({ ...options, storage: new MemorySessionStorage(history), context: { ...options.context, enabled },
			transformContext: context => { order.push("host"); fixedTokens = context.budget.fixedTokens; return context.messages; },
			adapter: nativeAdapter(model, async function* (request) {
				if (JSON.stringify(request.systemPrompts).includes(SUMMARY_SYSTEM)) { order.push("summary"); yield* responseChunks(checkpoint); }
				else { order.push("task"); usageAtRequest = agent.getUsage()?.contextTokens; expect(request.tools?.map(tool => tool.name)).toContain("load_skill"); expect(request.tools?.map(tool => tool.name)).toContain("read_skill_resource"); yield* responseChunks(answer); }
			}) });
		try { return { ...await consume(agent.runTurn("Continue")), order, usageAtRequest, fixedTokens }; }
		finally { await agent.dispose(); }
	};
	const withoutCompaction = await run(false);
	const compacted = await run(true);
	expect(withoutCompaction.result.status).toBe("success");
	expect(withoutCompaction.usageAtRequest).toBeGreaterThan(4000);
	expect(compacted.result.status).toBe("success");
	expect(compacted.order).toEqual(["summary", "host", "task"]);
	expect(compacted.events.find(event => event.type === "compaction" && event.phase === "end")).toMatchObject({ beforeTokens: withoutCompaction.usageAtRequest, afterTokens: compacted.usageAtRequest });
	expect(compacted.fixedTokens).toBeGreaterThan(1000);
}));

test("a tool continuation prepares a fresh budget from its new canonical messages", () => withScenario("continuation-compaction-budget", async scenario => {
	const history = longHistory();
	const tool = { name: "lookup", label: "Lookup", description: "Look up a result", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
		async execute() { return { content: [{ type: "text" as const, text: "Checked result. ".repeat(40) }], details: null }; } };
	const run = async (enabled: boolean, reserveTokens: number) => {
		const usageAtRequest: number[] = [];
		let taskCalls = 0;
		const agent = await createAgent({ cwd: scenario.cwd, systemPrompt: "BASE", model, maxTokens: 512, contextWindow: 8000,
			context: { enabled, reserveTokens, keepRecentTokens: 100 }, retry: { enabled: false }, storage: new MemorySessionStorage(history),
			permission: { rules: [{ tool: "lookup", argsPattern: "*", effect: "allow" }] }, tools: [tool],
			adapter: nativeAdapter(model, async function* (request) {
				if (JSON.stringify(request.systemPrompts).includes(SUMMARY_SYSTEM)) yield* responseChunks(checkpoint);
				else {
					usageAtRequest.push(agent.getUsage()?.contextTokens ?? -1);
					yield* responseChunks(++taskCalls === 1 ? { role: "assistant", timestamp: 2, stopReason: "tool_use", content: [{ type: "tool_call", id: "lookup-1", name: "lookup", arguments: {} }] } : answer);
				}
			}) });
		try { return { ...await consume(agent.runTurn("Continue")), usageAtRequest }; }
		finally { await agent.dispose(); }
	};
	const baseline = await run(false, 4000);
	expect(baseline.result.status).toBe("success");
	expect(baseline.usageAtRequest).toHaveLength(2);
	const [first, second] = baseline.usageAtRequest;
	expect(second).toBeGreaterThan(first!);
	const threshold = Math.floor((first! + second!) / 2);
	const automatic = await run(true, 8000 - threshold);
	expect(automatic.result.status).toBe("success");
	expect(automatic.usageAtRequest).toHaveLength(2);
	expect(automatic.events.filter(event => event.type === "compaction" && event.phase === "start")).toHaveLength(1);
	expect(automatic.events.find(event => event.type === "compaction" && event.phase === "end")).toMatchObject({ reason: "threshold", beforeTokens: second, afterTokens: automatic.usageAtRequest[1] });
}));

for (const source of ["fixed", "protected"] as const) test(`${source} material that cannot fit fails before model I/O without a checkpoint`, () => withScenario(`${source}-budget-failure`, async scenario => {
	const storage = new MemorySessionStorage();
	let requests = 0;
	const agent = await createAgent({ cwd: scenario.cwd, systemPrompt: source === "fixed" ? "System material ".repeat(900) : "BASE", model,
		contextWindow: 4000, maxTokens: 512, context: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 }, storage,
		adapter: nativeAdapter(model, async function* () { requests++; yield* responseChunks(answer); }),
	});
	try {
		const turn = await consume(agent.runTurn(source === "protected" ? "Current request ".repeat(900) : "short request"));
		expect(turn.result.status).toBe("error");
		expect(turn.events.find(event => event.type === "compaction" && event.phase === "error")).toMatchObject({ type: "compaction", phase: "error", reason: "threshold", error: "protected_context_budget_exceeded" });
		expect(turn.events.some(event => event.type === "compaction" && event.phase === "attempt")).toBe(false);
		expect(requests).toBe(0);
		expect((await storage.load()).entries.some(entry => entry.type === "compaction")).toBe(false);
	} finally { await agent.dispose(); }
}));
