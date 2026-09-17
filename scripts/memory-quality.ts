/** Explicit paid experiment. Never invoked by bun test or CI.
 * bun scripts/memory-quality.ts --split development --out /tmp/forge-memory-development.json
 */
import { createAgent, LongTermMemory, type MemoryScope, type Agent } from "../packages/core/src/sdk.ts";
import { loadConfig, resolveSecret } from "../packages/core/src/config.ts";
import { createMemoryHost } from "../packages/cli/src/memory-host.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { HarnessTool } from "../packages/tools/src/types.ts";

interface Case { id: string; split: string; mode: string; scope: MemoryScope; learn: string; recall: string; rubric: string; seed?: string; inherited?: boolean; verify?: boolean; }
const args = process.argv.slice(2);
const option = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1] ?? fallback : fallback;
const split = option("--split", "development"), out = option("--out", "/tmp/forge-memory-quality.json");
const fixturePath = option("--fixture", new URL("fixtures/memory-quality-v1.json", import.meta.url).pathname);
const fixtureText = await Bun.file(fixturePath).text();
const cases = (JSON.parse(fixtureText) as { cases: Case[] }).cases.filter(item => item.split === split && (!args.includes("--case") || item.id === option("--case", "")));
if (!cases.length) throw new Error("No quality cases selected");
const config = await loadConfig({ cwd: process.cwd() });
if (!config.provider || !config.model) throw new Error("Configure provider/model before this explicit experiment");
const model = builtinModels().getModel(config.provider, config.model);
if (!model || model.cost.input <= 0 || model.cost.output <= 0) throw new Error("Known positive model prices required");
const apiKey = await resolveSecret(config.apiKey);
const root = await mkdtemp(join(tmpdir(), "forge-memory-quality-"));
const implementation = ["packages/core/src/agent.ts", "packages/core/src/agent-port.ts", "packages/core/src/agent-session.ts", "packages/core/src/pi-port.ts", "packages/core/src/context/assembler.ts", "packages/core/src/memory/store.ts", "packages/core/src/memory/files.ts", "packages/core/src/memory/copy.ts", "packages/core/src/memory/tools.ts", "packages/cli/src/memory-host.ts"];
const hash = createHash("sha256"); for (const path of implementation) hash.update(path).update(await Bun.file(path).text());
const fixtureHash = createHash("sha256").update(fixtureText).digest("hex");
const harnessHash = createHash("sha256").update(await Bun.file(import.meta.path).text()).digest("hex");
let reservedCost = 0, turnRequests = 0, totalRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (...parameters: Parameters<typeof fetch>) => {
	const request = new Request(parameters[0], parameters[1]);
	const body = await request.clone().text();
	const reserve = (Buffer.byteLength(body) * model.cost.input + 2048 * model.cost.output) / 1e6;
	if (++turnRequests > 8 || ++totalRequests > 180 || reservedCost + reserve > 5) throw new Error("Quality request/cost budget exhausted");
	reservedCost += reserve;
	return originalFetch(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]) });
}, { preconnect: originalFetch.preconnect });
const rows: unknown[] = [];
const record = async () => {
	const report = { split, fixtureHash, implementationHash: hash.copy().digest("hex"), harnessHash, provider: config.provider, model: config.model, thinking: "off", outputLimit: 2048, retryMaxRetries: 1, compactionEnabled: false, totalRequests, conservativeReservedCostUsd: reservedCost, note: "Raw evidence, not an automatic semantic pass. Review notes and responses against frozen rubrics. Automatic context compaction is disabled to isolate memory quality; software tests cover integration. Usage costs use catalog prices and are not an invoice.", rows };
	const serialized = JSON.stringify(report, null, 2);
	await Bun.write(out, apiKey ? serialized.replaceAll(apiKey, "[redacted]") : serialized);
};
const checkTool: HarnessTool<object, unknown> = { name: "check_fixture", label: "Check fixture", description: "Run the one-off migration fixture check and return its actual result.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, async execute() { return { content: [{ type: "text", text: "E_DEMO_19: migration check FAILED. No repair or successful deployment has occurred." }], details: { exitCode: 1 }, isError: true }; } };

async function run(input: string, memory?: LongTermMemory, verify = false, autoUpdate = true) {
	turnRequests = 0;
	const started = Date.now(); let answer = "", costUsd = 0, inputTokens = 0, outputTokens = 0, usageReports = 0;
	const operations: unknown[] = [], errors: string[] = [];
	let agent: Agent | undefined;
	try {
		agent = await createAgent({ provider: config.provider!, model: config.model!, ...(apiKey ? { apiKey } : {}), ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), cwd: root, systemPrompt: "You are a helpful project assistant. Follow the user's scope and qualifications. Use available memory tools when useful for future conversations. Never invent recalled details. Be concise.", thinkingLevel: "off", maxTokens: 2048, retry: { enabled: true, maxRetries: 1 }, context: { enabled: false }, ...(memory ? { memory: { store: memory, autoUpdate, injection: true } } : {}), tools: verify ? [checkTool] : [], permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] } });
		const timer = setTimeout(() => agent?.abort(), 240000);
		try {
			const turn = agent.runTurn(input);
			for await (const event of turn) {
				if (event.type === "tool_execution_end" || event.type === "memory") operations.push(event);
				if (event.type === "message_end" && event.message.role === "assistant") {
					if (event.message.stopReason === "stop") answer = event.message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
					if (event.message.errorMessage) errors.push(event.message.errorMessage);
					const usage = event.message.usage;
					if (usage) { usageReports++; costUsd += usage.cost?.total ?? 0; inputTokens += usage.input + usage.cacheRead + usage.cacheWrite; outputTokens += usage.output; }
				}
			}
			const result = await turn.result;
			return { answer, result, errors, operations, requests: turnRequests, usageReports, inputTokens, outputTokens, costUsd, elapsedMs: Date.now() - started };
		} finally { clearTimeout(timer); }
	} finally { await agent?.dispose(); }
}
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
	if (await child.exited) throw new Error(await new Response(child.stderr).text());
}
try {
	for (const item of cases) {
		console.log(`Starting ${item.id}`);
		const directory = join(root, item.id); await mkdir(directory);
		let memory = new LongTermMemory({ project: join(directory, "project"), user: join(directory, "user") });
		let mainMemory: LongTermMemory | undefined;
		if (item.inherited) {
			const main = join(directory, "main"); await mkdir(main); await git(main, "init");
			await git(main, "-c", "user.name=Quality", "-c", "user.email=quality@example.invalid", "commit", "--allow-empty", "-m", "fixture");
			mainMemory = (await createMemoryHost(main, join(directory, "data"))).memory;
			memory = mainMemory;
		}
		for (const path of Object.values(memory.roots)) await mkdir(path, { recursive: true });
		if (item.seed) {
			await writeFile(join(memory.roots.project!, "background.md"), item.seed);
			await writeFile(join(memory.roots.project!, "MEMORY.md"), "[Project background](background.md)\n");
		}
		if (item.inherited) {
			const branch = join(directory, "branch"); await git(join(directory, "main"), "worktree", "add", "-b", "quality", branch);
			memory = (await createMemoryHost(branch, join(directory, "data"))).memory;
		}
		const baselineLearn = await run(item.learn, undefined, item.verify);
		const baselineRecall = await run(item.recall);
		const learning = await run(item.learn, memory, item.verify);
		const recall = await run(item.recall, new LongTermMemory(memory.roots), false, false);
		const notes: Record<string, string> = {};
		for (const scope of Object.keys(memory.roots) as MemoryScope[]) for (const path of await memory.list(scope)) notes[`${scope}/${path}`] = await Bun.file(join(memory.roots[scope]!, path)).text();
		const mainAfter = mainMemory ? await Bun.file(join(mainMemory.roots.project!, "background.md")).text() : undefined;
		rows.push({ ...item, baselineLearn, baselineRecall, learning, recall, notes, ...(mainAfter ? { mainAfter } : {}) });
		await record();
		console.log(`Finished ${item.id}: calls=${learning.requests + recall.requests}, cost=$${(learning.costUsd + recall.costUsd).toFixed(5)}, files=${Object.keys(notes).length}`);
	}
} catch (error) {
	rows.push({ failure: apiKey ? String(error).replaceAll(apiKey, "[redacted]") : String(error) }); await record(); throw error;
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
