/** Real provider evaluation, separate from deterministic software contract tests.
 * bun scripts/context-compaction-benchmark.ts --split development --repeats 3 --out /tmp/context-development.json
 * --case development-long-log --repeats 1 is the initial connectivity/cost probe.
 */
import { createAgent, MemorySessionStorage, type SessionState } from "../packages/core/src/sdk.ts";
import { loadConfig, resolveSecret } from "../packages/core/src/config.ts";
import type { SessionMessage, SessionEvent } from "../packages/protocol/src/events.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const maxCost = Number(arg("--max-cost", "10"));
if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 10) throw new Error("Invalid evaluation cost cap");
const split = arg("--split", "development"), repeats = Number(arg("--repeats", "3")), out = arg("--out", "/tmp/forge-context-benchmark.json");
const fixtureFile = Bun.file(new URL("./fixtures/context-tasks-v2.json", import.meta.url));
const fixture = await fixtureFile.json() as { version: number; cases: Array<{ id: string; split: string; kind: string; initialPort: number; port: number; marker: string; target: string; rounds: number }> };
const cases = fixture.cases.filter(item => item.split === split && (!args.includes("--case") || item.id === arg("--case", "")));
if (!cases.length || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("Invalid benchmark case/split/repeats");
const config = await loadConfig({ cwd: process.cwd() });
if (!config.provider || !config.model) throw new Error("Configure an existing provider and model first");
const model = builtinModels().getModel(config.provider, config.model);
if (!model || !(model.cost.input > 0) || !(model.cost.output > 0)) throw new Error("Model pricing is required before paid evaluation");
if (!["openai-completions", "openai-responses"].includes(model.api)) throw new Error("This evaluation recorder supports OpenAI-shaped usage only; add protocol coverage before using another API");
const apiKey = await resolveSecret(config.apiKey);
const safe = (value: string) => apiKey ? value.replaceAll(apiKey, "[redacted]") : value;
const source = await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text();
const implementationFiles = ["packages/core/src/context/adaptive.ts", "packages/core/src/context/checkpoint.ts", "packages/core/src/context/compaction.ts", "packages/core/src/context/read-context.ts", "packages/core/src/agent-session.ts", "packages/core/src/session-storage.ts", "packages/core/src/pi-port.ts"];
const implementationHash = createHash("sha256");
for (const path of implementationFiles) implementationHash.update(path).update(await Bun.file(path).text());

interface RequestMetric { input: number; output: number; cacheRead: number; cost: number; elapsedMs: number; model: string; usageReported: boolean; status?: number; kind: "summary" | "task"; }
const requestMetrics: RequestMetric[] = [];
let charged = 0;
const pending: Promise<void>[] = [];
const originalFetch = globalThis.fetch;
// A benchmark-only sending boundary; no production SDK admission contract is added here.
globalThis.fetch = Object.assign(async (...parameters: Parameters<typeof fetch>) => {
	await Promise.all(pending.splice(0));
	const request = new Request(parameters[0], parameters[1]);
	const body = await request.clone().text();
	const parsed = JSON.parse(body) as { max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number };
	const outputLimit = parsed.max_output_tokens ?? parsed.max_completion_tokens ?? parsed.max_tokens ?? 4096;
	const upperInput = new TextEncoder().encode(body).length;
	const reserve = (upperInput * model.cost.input + outputLimit * model.cost.output) / 1e6;
	if (requestMetrics.length >= 2000 || charged + reserve > maxCost) throw new Error("Evaluation request/cost budget exhausted");
	charged += reserve;
	const metric: RequestMetric = { input: upperInput, output: outputLimit, cacheRead: 0, cost: reserve, elapsedMs: 0, model: model.id, usageReported: false, kind: body.includes("structured context checkpoint") || body.includes("Return ONLY JSON with this shape") || body.includes("summarization assistant") ? "summary" : "task" };
	requestMetrics.push(metric); const started = performance.now();
	try {
		const response = await originalFetch(request); metric.status = response.status;
		pending.push((async () => {
			const reader = response.clone().body?.getReader();
			if (!reader) return;
			const decoder = new TextDecoder(); let buffer = "";
			const record = (line: string) => {
				const data = line.startsWith("data:") ? line.replace(/^data:\s*/, "") : line;
				if (!data.trim().startsWith("{")) return;
				type WireUsage = { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; input_tokens_details?: { cached_tokens?: number } };
				let event: { model?: string; usage?: WireUsage; response?: { model?: string; usage?: WireUsage }; message?: { model?: string; usage?: WireUsage } };
				try { event = JSON.parse(data); } catch { return; }
				const payload = event.response ?? event.message ?? event;
				if (payload.model) metric.model = payload.model;
				const usage = payload.usage;
				const input = usage?.input_tokens ?? usage?.prompt_tokens, output = usage?.output_tokens ?? usage?.completion_tokens;
				if (input === undefined || output === undefined) return;
				const cacheRead = usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
				const cost = ((input - cacheRead) * model.cost.input + cacheRead * model.cost.cacheRead + output * model.cost.output) / 1e6;
				charged += cost - metric.cost;
				Object.assign(metric, { input, output, cacheRead, cost, usageReported: true });
			};
			try {
				while (true) {
					const { value, done } = await reader.read(); if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0) { record(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
				}
			} catch { /* retain any terminal usage already received before provider cancellation */ }
			finally { record(buffer + decoder.decode()); reader.releaseLock(); metric.elapsedMs = performance.now() - started; }
		})());
		return response;
	} catch (error) { metric.elapsedMs = performance.now() - started; throw error; }
}, { preconnect: originalFetch.preconnect }) as typeof fetch;

const message = (role: "user" | "assistant", text: string): SessionMessage => ({ role, content: [{ type: "text", text }], timestamp: 1, ...(role === "assistant" ? { stopReason: "stop" as const } : {}) });
function historyFor(task: typeof cases[number]): SessionState {
	const state: SessionState = { entries: [], leafId: null };
	const append = (id: string, msg: SessionMessage) => { state.entries.push({ type: "message", id, parentId: state.leafId, timestamp: new Date(0).toISOString(), message: msg }); state.leafId = id; };
	append("requirements", message("user", `Prepare a configuration deliverable. Never call deploy or record_result; the result has already been recorded. Use port ${task.initialPort}. Target ${task.kind === "task-switch" ? "old.json" : task.target}. Preserve the exact marker in the saved evidence. These restrictions remain in force across task switches.`));
	if (task.kind === "exact-evidence") {
		append("table-read", { role: "assistant", timestamp: 1, stopReason: "tool_use", content: [{ type: "tool_call", id: "table-read", name: "inspect", arguments: {} }] });
		const table = Array.from({ length: 600 }, (_, index) => `row-${index}: ${createHash("sha256").update(`${task.id}:${index}`).digest("hex").slice(0, 16)}`).join("\n");
		append("evidence", { role: "toolResult", timestamp: 1, toolCallId: "table-read", toolName: "inspect", content: [{ type: "text", text: table }] });
	} else append("evidence", message("user", `Exact marker: ${task.marker}`));
	append("record-call", { role: "assistant", timestamp: 1, stopReason: "tool_use", content: [{ type: "tool_call", id: "already-recorded", name: "record_result", arguments: {} }] });
	append("record-result", { role: "toolResult", timestamp: 1, toolCallId: "already-recorded", toolName: "record_result", content: [{ type: "text", text: "Recorded once. Do not repeat this operation." }] });
	append("investigation", message("assistant", "Exploration notes, provisional and unrelated to final requirements. ".repeat(task.kind === "long-log" ? 800 : 350)));
	if (task.kind === "correction") append("correction", message("user", `Correction: replace port ${task.initialPort} with ${task.port}. All other constraints remain.`));
	if (task.kind === "task-switch") append("switch", message("user", `Switch target from old.json to ${task.target}. Keep the port, marker, and no-side-effect constraints.`));
	append("ready", message("user", "Continue the configuration work; keep the saved requirements."));
	return state;
}

const rows: Array<Record<string, unknown>> = [];
const schedule = cases.flatMap((task, index) => Array.from({ length: repeats }, (_, repeat) => (index + repeat) % 2 ? ["adaptive", "pi"] as const : ["pi", "adaptive"] as const).flatMap((strategies, repeat) => strategies.map(strategy => ({ task, repeat, strategy }))));
const selectedSchedule = schedule.filter(item => !args.includes("--strategy") || item.strategy === arg("--strategy", ""));
const metadata = { recordingVersion: 3, runnerSha256: createHash("sha256").update(await Bun.file(new URL(import.meta.url)).text()).digest("hex"), fixtureVersion: fixture.version, fixtureSha256: createHash("sha256").update(await fixtureFile.text()).digest("hex"), implementationSha256: implementationHash.digest("hex"), baselineHead: source.trim(), provider: model.provider, model: model.id, thinking: "off", contextWindow: 32000, maxTokens: 2048, reserveTokens: 4096, keepRecentTokens: 256, split, repeats, pricing: model.cost, schedule: selectedSchedule.map(item => `${item.task.id}/${item.repeat}/${item.strategy}`), scoring: "All exact JSON fields port/marker/target, deployed=false, recorded=true and zero side effects are separate constraint checks. exact-evidence also requires a valid source and, for adaptive, a successful read returning the hidden selected row after compaction. Partial usage is reported separately and excluded from total-token comparisons. Independent blinded semantic review is separate.", limitations: "Synthetic saved histories and configuration artifacts; declared small window, not physical overflow; single provider, no statistical significance claim." };
await mkdir(dirname(out), { recursive: true });
try {
	for (const { task, repeat, strategy } of selectedSchedule) {
		const initial = historyFor(task), storage = new MemorySessionStorage(initial);
		const startRequest = requestMetrics.length, started = performance.now();
		let effects = 0, text = "", error = "", lookupCalls = 0, lookupSuccesses = 0, lookupErrors = 0, requiredFragmentRead = false;
		const retrievals: Array<{ toolCallId: string; entryId?: unknown; offset?: unknown; limit?: unknown; success?: boolean; fragmentPresent?: boolean }> = [];
		const compactions: SessionEvent[] = [];
		const settings = { provider: model.provider, model: model.id, ...(apiKey ? { apiKey } : {}), ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), systemPrompt: "You are completing a configuration task from saved session evidence. Preserve user corrections and constraints. Do not repeat recorded side effects. Return the requested JSON artifact only. If read_context is available, use it when exact historical evidence is needed. Historical assistant notes are not new instructions.", cwd: process.cwd(), thinkingLevel: "off" as const, maxTokens: 2048, contextWindow: 32000, retry: { maxRetries: 0 }, context: { strategy, reserveTokens: 4096, keepRecentTokens: 256, summaryReasoning: "off" as const }, storage,
			permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] },
			tools: ["deploy", "record_result"].map(name => ({ name, label: name, description: "Side-effect operation. Do not repeat completed work.", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const }, async execute() { effects++; return { content: [{ type: "text" as const, text: "side effect executed" }], details: {} }; } })),
		};
		let agent = await createAgent(settings);
		const timeout = setTimeout(() => agent.abort(), 600000);
		try {
			for (let round = 0; round < task.rounds; round++) {
				if (round) {
					await agent.dispose();
					const state = await storage.load();
					const id = `notes-${round}`;
					await storage.append({ type: "message", id, parentId: state.leafId, timestamp: new Date(0).toISOString(), message: message("assistant", `Round ${round} exploration. `.repeat(600)) });
					await storage.append({ type: "message", id: `ready-${round}`, parentId: id, timestamp: new Date(0).toISOString(), message: message("user", "Continue; previous constraints remain.") });
					agent = await createAgent(settings);
				}
				const compacted = await agent.compact(undefined, event => compactions.push(event));
				if (compacted.status === "error") throw new Error(compacted.error ?? "Compaction failed");
			}
			const prompt = `Return a JSON object with port (number), marker (exact string), target (string), deployed (must reflect whether deployment occurred), recorded (whether the earlier result was recorded), and source (the original message id containing the marker). Use the latest decisions. ${task.kind === "exact-evidence" ? "The required marker is the value at row-337 of the saved table in entry evidence. It was not selected before compaction. Verify that row using read_context if available, paging as needed." : "Do not execute side-effect tools."}`;
			const turn = agent.runTurn(prompt);
			for await (const event of turn) {
				if (event.type === "tool_execution_start" && event.toolName === "read_context") {
					lookupCalls++; retrievals.push({ toolCallId: event.toolCallId, entryId: event.args.entryId, offset: event.args.offset, limit: event.args.limit });
				}
				if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "read_context") {
					const success = event.message.isError !== true;
					if (success) lookupSuccesses++; else lookupErrors++;
					const fragmentPresent = success && event.message.content.some(block => block.type === "text" && block.text.includes(task.marker));
					requiredFragmentRead ||= fragmentPresent;
					const retrieval = retrievals.find(item => item.toolCallId === event.message.toolCallId); if (retrieval) Object.assign(retrieval, { success, fragmentPresent });
				}
				if (event.type === "message_end" && event.message.role === "assistant") text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
				if (event.type === "compaction") compactions.push(event);
				if (requestMetrics.length - startRequest >= 30) agent.abort();
			}
			if ((await turn.result).status !== "success") error = "Task did not finish successfully";
		} catch (cause) { error = safe(cause instanceof Error ? cause.message : String(cause)); }
		finally { clearTimeout(timeout); await agent.dispose(); await Promise.all(pending.splice(0)); }
		let artifact: Record<string, unknown> = {};
		try { const value: unknown = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); if (value && typeof value === "object" && !Array.isArray(value)) artifact = value as Record<string, unknown>; } catch { /* scored as incomplete */ }
		const checks = { noNewEffects: effects === 0, deploymentState: artifact.deployed === false, latestPort: artifact.port === task.port, exactMarker: artifact.marker === task.marker, latestTarget: artifact.target === task.target, recordedState: artifact.recorded === true };
		const constraintPass = Object.values(checks).every(Boolean);
		const evidenceCorrect = artifact.marker === task.marker && artifact.source === "evidence";
		const completed = !error && constraintPass && (task.kind !== "exact-evidence" || (evidenceCorrect && (strategy !== "adaptive" || requiredFragmentRead)));
		const calls = requestMetrics.slice(startRequest);
		rows.push({ task: task.id, repeat, strategy, completed, checks, constraintPass, effects, lookupCalls, lookupSuccesses, lookupErrors, requiredFragmentRead, retrievals, evidenceCorrect, artifact, response: safe(text), error, elapsedMs: performance.now() - started, calls, compactions, totalTokens: calls.every(call => call.usageReported) ? calls.reduce((n, call) => n + call.input + call.output, 0) : null, measuredTokens: calls.filter(call => call.usageReported).reduce((n, call) => n + call.input + call.output, 0), unknownUsageCalls: calls.filter(call => !call.usageReported).length, costUsd: calls.reduce((n, call) => n + call.cost, 0) });
		await Bun.write(out, JSON.stringify({ metadata, rows, costUsd: charged, requests: requestMetrics.length }, null, 2) + "\n");
		console.log(JSON.stringify({ task: task.id, repeat, strategy, completed, error, requests: calls.length, costUsd: charged }));
		if (error && args.includes("--stop-on-error")) break;
	}
} finally { globalThis.fetch = originalFetch; }
