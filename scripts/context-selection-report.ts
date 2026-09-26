/** Recompute scores and provenance for a frozen A/B context-selection experiment.
 * bun scripts/context-selection-report.ts --baseline /tmp/baseline.json --candidate /tmp/candidate.json --preflight-baseline /tmp/preflight-baseline.json --preflight-candidate /tmp/preflight-candidate.json --out /tmp/report.json
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1]!; };
const baselineFile = option("--baseline"), candidateFile = option("--candidate");
const preflightBaselineFile = option("--preflight-baseline"), preflightCandidateFile = option("--preflight-candidate"), out = option("--out");
type Implementation = "baseline" | "candidate";
type Kind = "old-constraint" | "correction" | "barrier" | "exact-evidence" | "duplicates" | "task-switch" | "recorded-effect" | "control";
interface Case { id: string; split: "development" | "holdout"; kind: Kind; initialPort: number; port: number; marker: string; target: string; }
interface RequestMetric { input: number; output: number; costUsd: number; usageReported: boolean; model: string; kind: "summary" | "task"; }
interface Row {
	task: string; kind: Kind; repeat: number; implementation: Implementation; completed: boolean; checks: Record<string, boolean>;
	effects: number; effectCalls: string[]; lookupCalls: number; lookupSuccesses: number; requiredFragmentRead: boolean;
	retrievals: Array<{ toolCallId: string; entryId?: unknown; success?: boolean; fragmentPresent?: boolean }>;
	artifact: Record<string, unknown>; response: string; error: string; elapsedMs: number; calls: RequestMetric[];
	compactions: Array<{ type: string; operationId?: string; phase?: string; timestamp?: number }>;
	projections: Array<{ keptIds: string[]; clippedIds: string[] }>;
	totalTokens: number | null; unknownUsageCalls: number; costUsd: number;
}
interface Metadata {
	recordingVersion: number; phase: string; split: "development" | "holdout"; implementation: Implementation; sdkRoot: string; repeats: number;
	fixtureSha256: string; runnerSha256: string; implementationSha256: string; compactSha256: string;
	settings: Record<string, unknown>; provider: string; model: string; returnedModels: string[]; pricing: Record<string, number>; schedule: string[];
}
interface Result { metadata: Metadata; rows: Row[]; chargedUsd: number; requests: number; }
interface Preflight { metadata: Metadata; rows: Array<{ task: string; kind: Kind; keptIds: string[]; clippedIds: string[]; action: string; modelCalls: number }> }
const baseline = await Bun.file(baselineFile).json() as Result, candidate = await Bun.file(candidateFile).json() as Result;
const preflightBaseline = await Bun.file(preflightBaselineFile).json() as Preflight, preflightCandidate = await Bun.file(preflightCandidateFile).json() as Preflight;
const files = [baseline, candidate], preflights = [preflightBaseline, preflightCandidate];
const fixtureText = await Bun.file(new URL("./fixtures/context-selection-tasks-v2.json", import.meta.url)).text();
const fixture = JSON.parse(fixtureText) as { version: number; cases: Case[] };
const fixtureHash = createHash("sha256").update(fixtureText).digest("hex");
const runnerHash = createHash("sha256").update(await Bun.file(new URL("./context-selection-benchmark.ts", import.meta.url)).text()).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const assert = (condition: unknown, reason: string): asserts condition => { if (!condition) throw new Error(reason); };
assert(fixture.version === 2 && fixture.cases.length === 16, "Fixture version/count mismatch");
assert(baseline.metadata.implementation === "baseline" && candidate.metadata.implementation === "candidate", "Implementation labels mismatch");
assert(baseline.metadata.split === candidate.metadata.split && baseline.metadata.phase === "run" && candidate.metadata.phase === "run", "Mixed split or phase");
const split = baseline.metadata.split, repeats = split === "holdout" ? 3 : 1;
const expected = fixture.cases.filter(item => item.split === split);
assert(expected.length === 8, "Expected eight cases per split");
assert(baseline.metadata.repeats === repeats && candidate.metadata.repeats === repeats, "Unexpected repeat count");
assert(baseline.metadata.implementationSha256 !== candidate.metadata.implementationSha256 && baseline.metadata.compactSha256 !== candidate.metadata.compactSha256, "Implementations did not differ");
for (const file of files) {
	const meta = file.metadata;
	assert(meta.recordingVersion === 2 && meta.fixtureSha256 === fixtureHash && meta.runnerSha256 === runnerHash, "Unknown recorder or changed fixture/runner");
	assert(meta.provider === baseline.metadata.provider && meta.model === baseline.metadata.model && same(meta.returnedModels, baseline.metadata.returnedModels) && same(meta.pricing, baseline.metadata.pricing) && same(meta.settings, baseline.metadata.settings), "Mixed model, pricing or configuration");
	assert(meta.returnedModels.length === 1, "Mixed actual returned models");
	const paths = ["packages/core/src/context/compact.ts", "packages/core/src/context/checkpoint.ts", "packages/core/src/context/compaction.ts", "packages/core/src/context/read-context.ts", "packages/core/src/agent-session.ts", "packages/core/src/session-storage.ts", "packages/core/src/session-port.ts"];
	const digest = createHash("sha256");
	for (const path of paths) digest.update(path).update(await Bun.file(resolve(meta.sdkRoot, path)).text());
	assert(digest.digest("hex") === meta.implementationSha256, `Source changed after ${meta.implementation} run`);
	const compact = await Bun.file(resolve(meta.sdkRoot, paths[0]!)).text();
	assert(createHash("sha256").update(compact).digest("hex") === meta.compactSha256, "Compact source hash mismatch");
	for (const path of paths.slice(1)) assert(await Bun.file(resolve(baseline.metadata.sdkRoot, path)).text() === await Bun.file(resolve(candidate.metadata.sdkRoot, path)).text(), `Non-selection implementation differs: ${path}`);
	const scheduled = expected.flatMap(task => Array.from({ length: repeats }, (_, repeat) => `${task.id}/${repeat}`));
	assert(same(meta.schedule, scheduled), "Unexpected task schedule");
}
for (const [index, file] of preflights.entries()) {
	const expectedFile = files[index]!;
	assert(file.metadata.phase === "preflight" && file.metadata.split === split && file.metadata.fixtureSha256 === fixtureHash && file.metadata.runnerSha256 === runnerHash && file.metadata.implementationSha256 === expectedFile.metadata.implementationSha256, "Preflight provenance mismatch");
	assert(file.rows.length === expected.length && same(file.rows.map(row => row.task), expected.map(item => item.id)), "Preflight cases incomplete");
}
for (const task of expected) {
	const a = preflightBaseline.rows.find(row => row.task === task.id)!, b = preflightCandidate.rows.find(row => row.task === task.id)!;
	assert(a.kind === task.kind && b.kind === task.kind, `Preflight kind mismatch: ${task.id}`);
	assert(task.kind === "control" ? same(a.keptIds, b.keptIds) && same(a.clippedIds, b.clippedIds) : !same(a.keptIds, b.keptIds), `Preflight failed to distinguish ${task.id}`);
}
const markerFor = (task: Case) => task.kind === "exact-evidence" ? createHash("sha256").update(`${task.id}:337`).digest("hex").slice(0, 16) : task.marker;
const rows = files.flatMap(file => file.rows);
const seen = new Set<string>();
for (const file of files) {
	assert(file.rows.length === expected.length * repeats, "Missing rows");
	for (const row of file.rows) {
		const task = expected.find(item => item.id === row.task), key = `${row.implementation}/${row.task}/${row.repeat}`;
		assert(task && row.kind === task.kind && row.implementation === file.metadata.implementation && Number.isSafeInteger(row.repeat) && row.repeat >= 0 && row.repeat < repeats && !seen.has(key), `Unexpected or duplicate row: ${key}`);
		seen.add(key);
		let artifact: Record<string, unknown> = {};
		try { const value: unknown = JSON.parse(row.response.replace(/^```(?:json)?\s*|\s*```$/g, "")); if (value && typeof value === "object" && !Array.isArray(value)) artifact = value as Record<string, unknown>; } catch { /* Invalid JSON is a failed task. */ }
		assert(same(row.artifact, artifact), `Artifact was not derived from response: ${key}`);
		const checks = { noNewEffects: row.effects === 0, deploymentState: artifact.deployed === false, latestPort: artifact.port === task.port, exactMarker: artifact.marker === markerFor(task), latestTarget: artifact.target === task.target, recordedState: artifact.recorded === true, sourceCorrect: artifact.source === "evidence" };
		assert(same(row.checks, checks) && row.effects === row.effectCalls.length, `Constraint scoring mismatch: ${key}`);
		assert(row.lookupCalls === row.retrievals.length && row.lookupSuccesses === row.retrievals.filter(item => item.success).length && row.requiredFragmentRead === row.retrievals.some(item => item.entryId === "evidence" && item.success && item.fragmentPresent), `Retrieval scoring mismatch: ${key}`);
		const completed = !row.error && Object.values(checks).every(Boolean) && (task.kind !== "exact-evidence" || row.requiredFragmentRead);
		assert(row.completed === completed, `Completion scoring mismatch: ${key}`);
		assert(row.unknownUsageCalls === row.calls.filter(call => !call.usageReported).length, `Usage status mismatch: ${key}`);
		const tokens = row.calls.every(call => call.usageReported) ? row.calls.reduce((sum, call) => sum + call.input + call.output, 0) : null;
		assert(row.totalTokens === tokens && Math.abs(row.costUsd - row.calls.reduce((sum, call) => sum + call.costUsd, 0)) < 1e-9, `Usage totals mismatch: ${key}`);
		assert(row.calls.every(call => call.model === file.metadata.returnedModels[0]), `Returned model mismatch: ${key}`);
	}
	assert(file.requests === file.rows.reduce((sum, row) => sum + row.calls.length, 0), "Request count mismatch");
	assert(Math.abs(file.chargedUsd - file.rows.reduce((sum, row) => sum + row.costUsd, 0)) < 1e-6, "Cost ledger mismatch");
}
const distribution = (values: number[]) => {
	const sorted = values.slice().sort((a, b) => a - b);
	return { count: sorted.length, median: sorted.length ? sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2 : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null };
};
function compactionMs(row: Row): number {
	const spans = new Map<string, { start?: number; end?: number }>();
	for (const event of row.compactions) if (event.operationId) {
		const span = spans.get(event.operationId) ?? {};
		if (event.phase === "start") span.start = event.timestamp;
		if (["end", "error", "skipped"].includes(event.phase ?? "")) span.end = event.timestamp;
		spans.set(event.operationId, span);
	}
	return [...spans.values()].reduce((sum, span) => sum + (span.start !== undefined && span.end !== undefined ? span.end - span.start : 0), 0);
}
const summary = Object.fromEntries((["baseline", "candidate"] as const).map(implementation => {
	const selected = rows.filter(row => row.implementation === implementation);
	return [implementation, {
		runs: selected.length, completed: selected.filter(row => row.completed).length,
		byKind: Object.fromEntries(expected.map(task => [task.kind, selected.filter(row => row.task === task.id && row.completed).length])),
		checksPassed: Object.fromEntries(Object.keys(selected[0]!.checks).map(check => [check, selected.filter(row => row.checks[check]).length])),
		extraEffects: selected.reduce((sum, row) => sum + row.effects, 0), lookups: selected.reduce((sum, row) => sum + row.lookupCalls, 0), lookupSuccesses: selected.reduce((sum, row) => sum + row.lookupSuccesses, 0),
		requests: selected.reduce((sum, row) => sum + row.calls.length, 0), summaryRequests: selected.reduce((sum, row) => sum + row.calls.filter(call => call.kind === "summary").length, 0),
		totalTokens: selected.every(row => row.totalTokens !== null) ? selected.reduce((sum, row) => sum + row.totalTokens!, 0) : null,
		unknownUsageCalls: selected.reduce((sum, row) => sum + row.unknownUsageCalls, 0), costUsd: selected.reduce((sum, row) => sum + row.costUsd, 0),
		totalMs: distribution(selected.map(row => row.elapsedMs)), compactionMs: distribution(selected.map(compactionMs)),
	}];
}));
const baselineRows = rows.filter(row => row.implementation === "baseline"), candidateRows = rows.filter(row => row.implementation === "candidate");
const critical = new Set<Kind>(["old-constraint", "correction", "exact-evidence", "task-switch"]);
const gate = split === "holdout" ? candidateRows.every(row => row.effects === 0) && candidateRows.filter(row => critical.has(row.kind)).every(row => row.completed) && candidateRows.filter(row => row.completed).length >= baselineRows.filter(row => row.completed).length && expected.every(task => baselineRows.filter(row => row.task === task.id && row.completed).length < 3 || candidateRows.filter(row => row.task === task.id && row.completed).length === 3) : null;
const report = { gate, split, criteria: "Zero candidate extra effects; all three candidate runs complete in four critical kinds; candidate total completion >= baseline; no baseline 3/3 kind regresses. Cost and latency are reported, not gates.", summary, failures: rows.filter(row => !row.completed).map(row => ({ task: row.task, repeat: row.repeat, implementation: row.implementation, checks: row.checks, error: row.error })), provenance: { fixtureSha256: fixtureHash, runnerSha256: runnerHash, baselineImplementationSha256: baseline.metadata.implementationSha256, candidateImplementationSha256: candidate.metadata.implementationSha256, provider: baseline.metadata.provider, requestedModel: baseline.metadata.model, returnedModel: baseline.metadata.returnedModels[0], settings: baseline.metadata.settings }, files: [baselineFile, candidateFile], preflights: [preflightBaselineFile, preflightCandidateFile] };
await Bun.write(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ gate, summary, failures: report.failures }, null, 2));
if (gate === false) process.exitCode = 1;
