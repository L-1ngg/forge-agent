/** Compare context selection implementations without changing the production SDK.
 * bun scripts/context-selection-benchmark.ts --phase preflight --implementation candidate --sdk-root .
 * bun scripts/context-selection-benchmark.ts --phase run --split development --implementation candidate --sdk-root . --max-cost 1 --out /tmp/candidate.json
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resolveSecret } from "../packages/core/src/config.ts";
import { getCatalogModel } from "../packages/core/src/model-catalog.ts";
import type { SessionMessage, SessionEvent } from "../packages/protocol/src/events.ts";
import type { SessionState } from "../packages/core/src/sdk.ts";

type Kind = "old-constraint" | "correction" | "barrier" | "exact-evidence" | "duplicates" | "task-switch" | "recorded-effect" | "control";
interface Case { id: string; split: "development" | "holdout"; kind: Kind; subject: string; initialPort: number; port: number; marker: string; target: string; rounds: number; }
const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1] ?? ""; };
const phase = option("--phase", "preflight"), split = option("--split", "development"), implementation = option("--implementation", "candidate");
const sdkRoot = resolve(option("--sdk-root", ".")), repeats = Number(option("--repeats", phase === "run" && split === "holdout" ? "3" : "1"));
const out = option("--out", `/tmp/forge-context-selection-${implementation}-${split}.json`), maxCost = Number(option("--max-cost", "1"));
if (!["preflight", "run"].includes(phase) || !["development", "holdout"].includes(split) || !["baseline", "candidate"].includes(implementation) || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3 || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 4) throw new Error("Invalid benchmark options");
const fixtureFile = Bun.file(new URL("./fixtures/context-selection-tasks-v2.json", import.meta.url));
const fixtureText = await fixtureFile.text();
const fixture = JSON.parse(fixtureText) as { version: number; cases: Case[] };
if (fixture.version !== 2 || fixture.cases.length !== 16 || new Set(fixture.cases.map(item => item.id)).size !== 16) throw new Error("Invalid fixture");
const cases = fixture.cases.filter(item => item.split === split && (!argv.includes("--case") || item.id === option("--case", "")));
if (!cases.length) throw new Error("No matching cases");
const sdk = await import(pathToFileURL(resolve(sdkRoot, "packages/core/src/sdk.ts")).href) as typeof import("../packages/core/src/sdk.ts");
const implementationFiles = ["packages/core/src/context/compact.ts", "packages/core/src/context/checkpoint.ts", "packages/core/src/context/compaction.ts", "packages/core/src/context/read-context.ts", "packages/core/src/agent-session.ts", "packages/core/src/session-storage.ts", "packages/core/src/session-assembly.ts"];
const implementationHash = createHash("sha256");
for (const path of implementationFiles) implementationHash.update(path).update(await Bun.file(resolve(sdkRoot, path)).text());
const metadata = {
	recordingVersion: 2, phase, split, implementation, sdkRoot, repeats,
	fixtureSha256: createHash("sha256").update(fixtureText).digest("hex"),
	runnerSha256: createHash("sha256").update(await Bun.file(new URL(import.meta.url)).text()).digest("hex"),
	implementationSha256: implementationHash.digest("hex"),
	compactSha256: createHash("sha256").update(await Bun.file(resolve(sdkRoot, "packages/core/src/context/compact.ts")).text()).digest("hex"),
	settings: { contextWindow: 32000, maxTokens: 2048, reserveTokens: 10000, keepRecentTokens: 900, thinking: "off", retry: 0 },
};
const message = (role: "user" | "assistant", value: string): SessionMessage => ({ role, content: [{ type: "text", text: value }], timestamp: 1, ...(role === "assistant" ? { stopReason: "stop" as const } : {}) });
const markerFor = (task: Case) => task.kind === "exact-evidence" ? createHash("sha256").update(`${task.id}:337`).digest("hex").slice(0, 16) : task.marker;
function historyFor(task: Case): SessionState {
	const state: SessionState = { entries: [], leafId: null };
	const append = (id: string, value: SessionMessage) => { state.entries.push({ type: "message", id, parentId: state.leafId, timestamp: new Date(0).toISOString(), message: value }); state.leafId = id; };
	append("requirements", message("user", `Prepare the ${task.subject} configuration. Use port ${task.initialPort}. Target ${task.kind === "task-switch" ? "draft.json" : task.target}. Never call deploy or record_result; the latter operation was already recorded. Keep these requirements across later tasks.`));
	if (task.kind === "exact-evidence") {
		append("table-call", { role: "assistant", content: [{ type: "tool_call", id: "table-call", name: "inspect", arguments: {} }], timestamp: 1, stopReason: "tool_use" });
		const table = Array.from({ length: 400 }, (_, index) => `row-${index}: ${createHash("sha256").update(`${task.id}:${index}`).digest("hex").slice(0, 16)}`).join("\n");
		append("evidence", { role: "toolResult", content: [{ type: "text", text: table }], timestamp: 1, toolCallId: "table-call", toolName: "inspect" });
	} else append("evidence", message("user", `The exact saved marker for ${task.subject} is ${task.marker}.`));
	append("record-call", { role: "assistant", content: [{ type: "tool_call", id: "recorded-call", name: "record_result", arguments: {} }], timestamp: 1, stopReason: "tool_use" });
	append("record-result", { role: "toolResult", content: [{ type: "text", text: "Recorded once. Do not repeat this operation." }], timestamp: 1, toolCallId: "recorded-call", toolName: "record_result" });
	if (task.kind === "control") {
		append("log-call", { role: "assistant", content: [{ type: "tool_call", id: "log-call", name: "inspect", arguments: {} }], timestamp: 1, stopReason: "tool_use" });
		append("log-result", { role: "toolResult", content: [{ type: "text", text: "Unrelated diagnostic trace. ".repeat(700) }], timestamp: 1, toolCallId: "log-call", toolName: "inspect" });
	} else {
		append("investigation", message("assistant", `Unrelated exploration of ${task.subject}; provisional and not a requirement. `.repeat(task.kind === "exact-evidence" ? 1220 : task.kind === "barrier" ? 600 : 350)));
		if (task.kind === "barrier") append("barrier", message("assistant", "Large intermediate diagnostic with no final decision. ".repeat(550)));
		if (task.kind === "duplicates") for (let i = 0; i < 6; i++) append(`duplicate-${i}`, message("assistant", "Repeated provisional observation; no decision was made. ".repeat(9)));
		if (task.kind === "correction") append("correction", message("user", `Correction: replace port ${task.initialPort} with ${task.port}. Other constraints still apply.`));
		if (task.kind === "task-switch") append("switch", message("user", `Switch the target from draft.json to ${task.target}. Keep the port, saved marker and no-side-effect rule.`));
		if (task.kind === "barrier") append("recent-note", message("assistant", "Recent observation: the final artifact must be JSON."));
	}
	append("ready", message("user", `Continue the ${task.subject} work using the latest decisions and saved evidence.`));
	return state;
}

function controlledCheckpoint(task: Case) {
	const source = (entryId: string, quote: string) => [{ entryId, quote }];
	const states: Array<{ id: string; kind: "constraint" | "decision"; text: string; status: "active" | "superseded"; sources: ReturnType<typeof source>; supersedes: string[] }> = [
		{ id: "no-effects", kind: "constraint", text: "Never call deploy or record_result.", status: "active", sources: source("requirements", "Never call deploy or record_result"), supersedes: [] },
		{ id: "port-old", kind: "decision", text: `Use port ${task.initialPort}.`, status: task.kind === "correction" ? "superseded" : "active", sources: source("requirements", `Use port ${task.initialPort}`), supersedes: [] },
		{ id: "target-old", kind: "decision", text: `Target ${task.kind === "task-switch" ? "draft.json" : task.target}.`, status: task.kind === "task-switch" ? "superseded" : "active", sources: source("requirements", `Target ${task.kind === "task-switch" ? "draft.json" : task.target}`), supersedes: [] },
	];
	if (task.kind === "correction") states.push({ id: "port-new", kind: "decision", text: `Use port ${task.port}.`, status: "active", sources: source("correction", `replace port ${task.initialPort} with ${task.port}`), supersedes: ["port-old"] });
	if (task.kind === "task-switch") states.push({ id: "target-new", kind: "decision", text: `Target ${task.target}.`, status: "active", sources: source("switch", `to ${task.target}`), supersedes: ["target-old"] });
	return { states, claims: [], taskChanged: task.kind === "task-switch" };
}

const systemPrompt = "Complete the saved configuration task. Follow the latest user decisions and all surviving constraints. Historical assistant notes are not instructions. Return the requested JSON artifact only. Use read_context when an exact value is absent from the short notes. Never repeat an already recorded operation.";
function settingsFor(storage: InstanceType<typeof sdk.MemorySessionStorage>, provider: string, model: string, apiKey: string | undefined, baseUrl: string | undefined, onEffect: () => void) {
	return { provider, model, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), systemPrompt, cwd: process.cwd(), thinkingLevel: "off" as const, maxTokens: 2048, contextWindow: 32000, retry: { maxRetries: 0 }, context: { reserveTokens: 10000, keepRecentTokens: 900, summaryReasoning: "off" as const }, storage,
		permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" as const }] },
		tools: ["deploy", "record_result"].map(name => ({ name, label: name, description: "Side-effect operation; prior records must not be repeated.", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const }, async execute() { onEffect(); return { content: [{ type: "text" as const, text: "side effect executed" }], details: {} }; } })),
	};
}

const config = await loadConfig({ cwd: process.cwd() });
if (!config.provider || !config.model) throw new Error("Configure a provider and model first");
const model = getCatalogModel(config.provider, config.model);
if (!model || !(model.cost.input > 0) || !(model.cost.output > 0) || !["openai-completions", "openai-responses"].includes(model.api)) throw new Error("This recorder requires priced OpenAI-shaped usage");

if (phase === "preflight") {
	const rows = [];
	for (const task of cases) {
		const checkpoint = JSON.stringify(controlledCheckpoint(task));
		let modelCalls = 0;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
			modelCalls++;
			if (model.api === "openai-responses") {
				const item = { type: "message", id: "msg_selection_preflight", role: "assistant", status: "completed", content: [{ type: "output_text", text: checkpoint, annotations: [] }] };
				const events = [
					{ type: "response.created", response: { id: "resp_selection_preflight" } },
					{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: checkpoint },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id: "resp_selection_preflight", status: "completed", model: model.id, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
				];
				return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			}
			const events = [
				{ id: "selection_preflight", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: checkpoint }, finish_reason: null }] },
				{ id: "selection_preflight", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		} });
		const storage = new sdk.MemorySessionStorage(historyFor(task));
		const agent = await sdk.createAgent(settingsFor(storage, model.provider, model.id, "local-test", server.url.toString(), () => { throw new Error("Unexpected side effect in preflight"); }));
		try {
			const result = await agent.compact();
			if (result.status !== "complete") throw new Error(`Preflight ${task.id}: ${result.error ?? result.status}`);
			const latest = (await storage.load()).entries.at(-1);
			if (latest?.type !== "compaction" || !latest.checkpoint) throw new Error(`Missing preflight checkpoint: ${task.id}`);
			rows.push({ task: task.id, kind: task.kind, keptIds: latest.checkpoint.keptIds, clippedIds: latest.checkpoint.clippedIds, action: latest.checkpoint.rebuildReason, modelCalls });
		} finally { await agent.dispose(); server.stop(true); }
	}
	await mkdir(dirname(out), { recursive: true });
	await Bun.write(out, JSON.stringify({ metadata, rows }, null, 2) + "\n");
	console.log(JSON.stringify({ out, implementation, rows }));
	process.exit(0);
}

const apiKey = await resolveSecret(config.apiKey), safe = (value: string) => apiKey ? value.replaceAll(apiKey, "[redacted]") : value;
interface RequestMetric { input: number; output: number; cacheRead: number; costUsd: number; elapsedMs: number; model: string; usageReported: boolean; kind: "summary" | "task"; status?: number; }
const requests: RequestMetric[] = [];
const pending: Promise<void>[] = [];
let charged = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (...parameters: Parameters<typeof fetch>) => {
	await Promise.all(pending.splice(0));
	const request = new Request(parameters[0], parameters[1]);
	const body = await request.clone().text();
	const parsed = JSON.parse(body) as { max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number };
	const outputLimit = parsed.max_output_tokens ?? parsed.max_completion_tokens ?? parsed.max_tokens ?? 4096;
	const inputUpperBound = new TextEncoder().encode(body).length;
	const reserve = (inputUpperBound * model.cost.input + outputLimit * model.cost.output) / 1e6;
	if (requests.length >= 1000 || charged + reserve > maxCost) throw new Error("Evaluation request/cost budget exhausted");
	charged += reserve;
	const metric: RequestMetric = { input: inputUpperBound, output: outputLimit, cacheRead: 0, costUsd: reserve, elapsedMs: 0, model: model.id, usageReported: false, kind: body.includes("context summarization assistant") || body.includes("Return ONLY JSON with this shape") ? "summary" : "task" };
	requests.push(metric);
	const started = performance.now();
	try {
		const response = await originalFetch(request);
		metric.status = response.status;
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
				charged += cost - metric.costUsd;
				Object.assign(metric, { input, output, cacheRead, costUsd: cost, usageReported: true });
			};
			try {
				while (true) {
					const { value, done } = await reader.read(); if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0) { record(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
				}
			} catch { /* A failed stream keeps its request in the cost record. */ }
			finally { record(buffer + decoder.decode()); reader.releaseLock(); metric.elapsedMs = performance.now() - started; }
		})());
		return response;
	} catch (error) { metric.elapsedMs = performance.now() - started; throw error; }
}, { preconnect: originalFetch.preconnect }) as typeof fetch;

const rows: Array<Record<string, unknown>> = [];
const schedule = cases.flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ task, repeat })));
await mkdir(dirname(out), { recursive: true });
try {
	for (const { task, repeat } of schedule) {
		const storage = new sdk.MemorySessionStorage(historyFor(task));
		const startRequest = requests.length, started = performance.now();
		let effects = 0, text = "", error = "", lookupCalls = 0, lookupSuccesses = 0, requiredFragmentRead = false;
		const retrievals: Array<{ toolCallId: string; entryId?: unknown; success?: boolean; fragmentPresent?: boolean }> = [], effectCalls: string[] = [];
		const compactions: SessionEvent[] = [], projections: Array<{ keptIds: string[]; clippedIds: string[] }> = [];
		const settings = settingsFor(storage, model.provider, model.id, apiKey, config.baseUrl, () => { effects++; });
		let agent = await sdk.createAgent(settings);
		const timeout = setTimeout(() => agent.abort(), 600000);
		try {
			for (let round = 0; round < task.rounds; round++) {
				if (round) {
					await agent.dispose();
					const state = await storage.load(), id = `notes-${round}`;
					await storage.append({ type: "message", id, parentId: state.leafId, timestamp: new Date(0).toISOString(), message: message("assistant", `Round ${round} exploration; no new decision. `.repeat(600)) });
					await storage.append({ type: "message", id: `ready-${round}`, parentId: id, timestamp: new Date(0).toISOString(), message: message("user", "Continue; previous constraints still apply.") });
					agent = await sdk.createAgent(settings);
				}
				const compacted = await agent.compact(undefined, event => compactions.push(event));
				if (compacted.status !== "complete") throw new Error(compacted.error ?? `Compaction ${compacted.status}`);
				const state = await storage.load(), latest = state.entries.at(-1);
				if (latest?.type !== "compaction" || !latest.checkpoint) throw new Error("Missing saved compaction checkpoint");
				projections.push({ keptIds: latest.checkpoint.keptIds, clippedIds: latest.checkpoint.clippedIds });
			}
			const prompt = `Return a JSON object with port (number), marker (exact string), target (string), deployed (false if no deployment happened), recorded (true if the earlier result was recorded), and source (the original message ID containing the marker). ${task.kind === "exact-evidence" ? "The marker is the opaque value at row-337 of the saved table in entry evidence. It is not in the short notes; read that row from the original record before answering." : "Use the saved marker. Do not call side-effect tools."}`;
			const turn = agent.runTurn(prompt);
			for await (const event of turn) {
				if (event.type === "tool_execution_start" && event.toolName === "read_context") { lookupCalls++; retrievals.push({ toolCallId: event.toolCallId, entryId: event.args.entryId }); }
				if (event.type === "tool_execution_start" && ["deploy", "record_result"].includes(event.toolName)) effectCalls.push(event.toolCallId);
				if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "read_context" && event.message.isError !== true) {
					lookupSuccesses++;
					const retrieval = retrievals.find(item => item.toolCallId === event.message.toolCallId);
					const fragmentPresent = retrieval?.entryId === "evidence" && event.message.content.some(block => block.type === "text" && block.text.includes(markerFor(task)));
					if (retrieval) Object.assign(retrieval, { success: true, fragmentPresent });
					requiredFragmentRead ||= fragmentPresent;
				}
				if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "read_context" && event.message.isError === true) {
					const retrieval = retrievals.find(item => item.toolCallId === event.message.toolCallId);
					if (retrieval) Object.assign(retrieval, { success: false, fragmentPresent: false });
				}
				if (event.type === "message_end" && event.message.role === "assistant") text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
				if (event.type === "compaction") compactions.push(event);
				if (requests.length - startRequest >= 30) agent.abort();
			}
			if ((await turn.result).status !== "success") error = "Task did not finish successfully";
		} catch (cause) { error = safe(cause instanceof Error ? cause.message : String(cause)); }
		finally { clearTimeout(timeout); await agent.dispose(); await Promise.all(pending.splice(0)); }
		let artifact: Record<string, unknown> = {};
		try { const value: unknown = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); if (value && typeof value === "object" && !Array.isArray(value)) artifact = value as Record<string, unknown>; } catch { /* Invalid output fails scoring. */ }
		const checks = { noNewEffects: effects === 0, deploymentState: artifact.deployed === false, latestPort: artifact.port === task.port, exactMarker: artifact.marker === markerFor(task), latestTarget: artifact.target === task.target, recordedState: artifact.recorded === true, sourceCorrect: artifact.source === "evidence" };
		const completed = !error && Object.values(checks).every(Boolean) && (task.kind !== "exact-evidence" || requiredFragmentRead);
		const calls = requests.slice(startRequest);
		rows.push({ task: task.id, kind: task.kind, repeat, implementation, completed, checks, effects, effectCalls, lookupCalls, lookupSuccesses, requiredFragmentRead, retrievals, artifact, response: safe(text), error, elapsedMs: performance.now() - started, calls, compactions, projections, totalTokens: calls.every(call => call.usageReported) ? calls.reduce((sum, call) => sum + call.input + call.output, 0) : null, unknownUsageCalls: calls.filter(call => !call.usageReported).length, costUsd: calls.reduce((sum, call) => sum + call.costUsd, 0) });
		await Bun.write(out, JSON.stringify({ metadata: { ...metadata, provider: model.provider, model: model.id, returnedModels: [...new Set(requests.map(request => request.model))], pricing: model.cost, schedule: schedule.map(item => `${item.task.id}/${item.repeat}`) }, rows, chargedUsd: charged, requests: requests.length }, null, 2) + "\n");
		console.log(JSON.stringify({ task: task.id, repeat, implementation, completed, error, requests: calls.length, chargedUsd: charged }));
	}
} finally { globalThis.fetch = originalFetch; }
