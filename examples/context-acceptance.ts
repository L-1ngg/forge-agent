import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgent, type Agent } from "../packages/core/src/sdk.ts";
import { loadConfig, resolveSecret, SessionStore } from "../packages/core/src/index.ts";
import type { HarnessTool } from "../packages/tools/src/index.ts";
import type { SessionEvent } from "../packages/protocol/src/index.ts";

// Explicit, bounded live-provider acceptance. Never runs as part of bun test.
const config = await loadConfig({ cwd: process.cwd() });
if (!config.provider || !config.model) throw new Error("Configure a provider and model first");
const directory = await mkdtemp(join(tmpdir(), "forge-context-live-"));
const store = await SessionStore.open(join(directory, "session.jsonl"), directory);
const cursors = ["start", ...Array.from({ length: 3 }, () => randomUUID())];
let toolCalls = 0, modelCalls = 0, summaryCalls = 0, compactions = 0;
let agent: Agent | undefined;
const evidence: HarnessTool<{ cursor: string }, { page: number; evidence: string; next: string | null }> = {
	name: "next_evidence", label: "Read evidence", description: "Read the next evidence page using the cursor from the previous result.",
	parameters: { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"], additionalProperties: false },
	async execute({ cursor }) {
		const index = cursors.indexOf(cursor);
		if (index !== toolCalls) throw new Error("Read each evidence cursor once in order");
		toolCalls++;
		const details = { page: index + 1, evidence: "Target database: analytics-db. Maximum batch size: 17. Preserve both constraints.\n" + "This is supporting audit material without additional requirements.\n".repeat(90), next: cursors[index + 1] ?? null };
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	},
};
const apiKey = await resolveSecret(config.apiKey);
const settings = {
	provider: config.provider, model: config.model, cwd: directory,
	...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
	...(apiKey ? { apiKey } : {}),
	systemPrompt: "Complete the user's task. Read evidence sequentially, obey tool cursors, and preserve the target database and batch-size constraints.",
	thinkingLevel: "off" as const, maxTokens: 1024, contextWindow: 6000,
	context: { reserveTokens: 1024, keepRecentTokens: 2000 }, retry: { enabled: false },
	storage: store.asStorage(), tools: [evidence],
	permission: { rules: [{ tool: "next_evidence", argsPattern: "*", effect: "allow" as const }] },
};
const observe = (event: SessionEvent) => {
	if (event.type === "message_start" && event.message.role === "assistant") modelCalls++;
	if (event.type === "compaction" && event.phase === "attempt") summaryCalls++;
	if (event.type === "compaction" && event.phase === "end") compactions++;
	if (modelCalls + summaryCalls >= 16) agent?.abort();
};
const timer = setTimeout(() => agent?.abort(), 180000);
try {
	agent = await createAgent(settings);
	for await (const event of agent.runTurn("Starting with cursor start, use next_evidence until next is null. Await each result before choosing the next cursor. Then state the target database and maximum batch size.")) observe(event);
	await agent.dispose();
	const saved = await store.load();
	const checkpoints = saved.entries.filter((entry) => entry.type === "compaction");
	if (toolCalls !== 4 || !checkpoints.length) throw new Error("Live workflow did not reach four tools and automatic compaction");
	agent = await createAgent({ ...settings, storage: (await SessionStore.open(store.path, directory)).asStorage() });
	let answer = "";
	for await (const event of agent.runTurn("Without using tools, state the target database and maximum batch size from our completed evidence review.")) {
		observe(event);
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop") answer = event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
	}
	const passed = answer.includes("analytics-db") && /\b17\b/.test(answer);
	console.log(JSON.stringify({ provider: config.provider, model: config.model, toolCalls, modelCalls, summaryCalls, compactions, reopenedConstraintsPreserved: passed, physicalOverflowTested: false }));
	if (!passed) throw new Error("Reopened task did not preserve the evidence constraints");
} finally {
	clearTimeout(timer);
	await agent?.dispose();
	await rm(directory, { recursive: true, force: true });
}
