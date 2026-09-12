/** Aggregate complete frozen holdout runs. No model calls.
 * bun scripts/context-compaction-report.ts <directory of six result JSON files> <output.json> [whitespace-proof.json]
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [directory, output, equivalencePath] = process.argv.slice(2);
if (!directory || !output) throw new Error("Expected results directory and output path");
interface Row {
	task: string; repeat: number; strategy: "pi" | "adaptive"; completed: boolean; constraintPass: boolean;
	checks: Record<string, boolean>; effects: number; lookupCalls: number; lookupSuccesses: number; lookupErrors: number; requiredFragmentRead: boolean; evidenceCorrect: boolean;
	artifact: Record<string, unknown>; response: string; error: string; elapsedMs: number; totalTokens: number | null; measuredTokens: number; unknownUsageCalls: number; costUsd: number;
	calls: Array<{ kind: "task" | "summary"; usageReported: boolean; model: string }>;
	compactions: Array<{ type: string; phase?: string; operationId?: string; timestamp: number; reason?: string; stopReason?: string; usage?: unknown }>;
}
interface ResultFile { metadata: { fixtureSha256: string; model: string; provider: string; split: string; implementationSha256: string; [key: string]: unknown }; rows: Row[]; costUsd: number; requests: number; }
const fixtureText = await Bun.file(new URL("./fixtures/context-tasks-v2.json", import.meta.url)).text();
const fixture = JSON.parse(fixtureText) as { cases: Array<{ id: string; split: string; kind: string; port: number; marker: string; target: string }> };
const files: ResultFile[] = [];
for (const file of (await readdir(directory)).filter(file => file.endsWith(".json")).sort()) files.push(await Bun.file(join(directory, file)).json());
if (!files.length) throw new Error("No result files");
const first = files[0]!.metadata;
const rows = files.flatMap(file => file.rows);
for (const file of files) {
	if (file.metadata.fixtureSha256 !== createHash("sha256").update(fixtureText).digest("hex") || file.metadata.split !== first.split || file.metadata.model !== first.model || file.metadata.provider !== first.provider) throw new Error("Mixed fixture, split or model");
}
// A historical formatting-only change may be admitted with a reproducible proof,
// never by silently ignoring differing implementation hashes.
const implementationHashes = new Set(files.map(file => file.metadata.implementationSha256));
let equivalence: unknown = null;
if (implementationHashes.size > 1) {
	if (!equivalencePath) throw new Error("Mixed implementations require a verified whitespace equivalence proof");
	const proof = await Bun.file(equivalencePath).json() as { path: string; line: number; oldWhitespace: string; oldHash: string; newHash: string };
	const paths = ["packages/core/src/context/adaptive.ts", "packages/core/src/context/checkpoint.ts", "packages/core/src/context/compaction.ts", "packages/core/src/context/read-context.ts", "packages/core/src/agent-session.ts", "packages/core/src/session-storage.ts", "packages/core/src/pi-port.ts"];
	if (!paths.includes(proof.path) || !Number.isSafeInteger(proof.line) || proof.line < 1 || !/^[ \t]*$/.test(proof.oldWhitespace)) throw new Error("Invalid whitespace proof");
	const current = createHash("sha256"), previous = createHash("sha256");
	for (const path of paths) {
		const text = await Bun.file(path).text();
		current.update(path).update(text);
		const lines = text.split("\n");
		if (path === proof.path) {
			if (lines[proof.line - 1] !== "") throw new Error("Proof must refer to an empty source line");
			lines[proof.line - 1] = proof.oldWhitespace;
		}
		previous.update(path).update(lines.join("\n"));
	}
	if (current.digest("hex") !== proof.newHash || previous.digest("hex") !== proof.oldHash || [...implementationHashes].some(hash => hash !== proof.newHash && hash !== proof.oldHash)) throw new Error("Implementation equivalence proof mismatch");
	equivalence = proof;
}
for (const file of files) {
	for (const key of ["thinking", "contextWindow", "maxTokens", "reserveTokens", "keepRecentTokens", "repeats", "pricing"]) {
		if (file.metadata[key] === undefined || JSON.stringify(file.metadata[key]) !== JSON.stringify(first[key])) throw new Error(`Mixed or missing configuration: ${key}`);
	}
	if (file.metadata.recordingVersion !== undefined && file.metadata.recordingVersion !== 3) throw new Error("Unknown recorder version");
}
const returnedModels = [...new Set(rows.flatMap(row => row.calls.map(call => call.model)))];
if (returnedModels.length !== 1) throw new Error("Mixed returned model identifiers");
const expected = fixture.cases.filter(task => task.split === first.split);
const keys = new Set<string>();
for (const row of rows) {
	const task = expected.find(task => task.id === row.task);
	const key = `${row.task}/${row.strategy}/${row.repeat}`;
	if (!task || !["pi", "adaptive"].includes(row.strategy) || keys.has(key) || ![0, 1, 2].includes(row.repeat)) throw new Error("Unexpected or duplicate run");
	keys.add(key);
	const checks = { noNewEffects: row.effects === 0, deploymentState: row.artifact.deployed === false, latestPort: row.artifact.port === task.port, exactMarker: row.artifact.marker === task.marker, latestTarget: row.artifact.target === task.target, recordedState: row.artifact.recorded === true };
	const constraintPass = Object.values(checks).every(Boolean);
	const evidenceCorrect = row.artifact.marker === task.marker && row.artifact.source === "evidence";
	const complete = !row.error && constraintPass && (task.kind !== "exact-evidence" || (evidenceCorrect && (row.strategy !== "adaptive" || row.requiredFragmentRead)));
	if (JSON.stringify(checks) !== JSON.stringify(row.checks) || constraintPass !== row.constraintPass || evidenceCorrect !== row.evidenceCorrect || complete !== row.completed) throw new Error(`Scoring mismatch: ${key}`);
}
for (const task of expected) for (const strategy of ["pi", "adaptive"]) for (let repeat = 0; repeat < 3; repeat++) if (!keys.has(`${task.id}/${strategy}/${repeat}`)) throw new Error(`Missing run ${task.id}/${strategy}/${repeat}`);

const distribution = (values: number[]) => {
	const sorted = values.slice().sort((a, b) => a - b);
	return { n: sorted.length, median: sorted.length ? sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2 : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null };
};
function compactTime(row: Row): number {
	const operations = new Map<string, { start?: number; end?: number }>();
	for (const event of row.compactions) if (event.operationId) {
		const operation = operations.get(event.operationId) ?? {};
		if (event.phase === "start") operation.start = event.timestamp;
		if (event.phase === "end" || event.phase === "error" || event.phase === "skipped") operation.end = event.timestamp;
		operations.set(event.operationId, operation);
	}
	return [...operations.values()].reduce((sum, operation) => sum + (operation.start !== undefined && operation.end !== undefined ? operation.end - operation.start : 0), 0);
}
const summary = Object.fromEntries((["pi", "adaptive"] as const).map(strategy => {
	const runs = rows.filter(row => row.strategy === strategy);
	return [strategy, {
		runs: runs.length, completed: runs.filter(row => row.completed).length, constraintsPassed: runs.filter(row => row.constraintPass).length,
		checksPassed: Object.fromEntries(Object.keys(runs[0]!.checks).map(key => [key, runs.filter(row => row.checks[key]).length])),
		evidenceCorrectRuns: runs.filter(row => row.evidenceCorrect).length, extraEffects: runs.reduce((sum, row) => sum + row.effects, 0), lookups: runs.reduce((sum, row) => sum + row.lookupCalls, 0), lookupSuccesses: runs.reduce((sum, row) => sum + row.lookupSuccesses, 0), lookupErrors: runs.reduce((sum, row) => sum + row.lookupErrors, 0),
		exactEvidenceRuns: runs.filter(row => row.task.endsWith("exact-evidence")).map(row => ({ repeat: row.repeat, evidenceCorrect: row.evidenceCorrect, fragmentRead: row.requiredFragmentRead, lookupCalls: row.lookupCalls })),
		totalTokens: distribution(runs.flatMap(row => row.totalTokens === null ? [] : [row.totalTokens])),
		unknownUsageCalls: runs.reduce((sum, row) => sum + row.unknownUsageCalls, 0), totalMs: distribution(runs.map(row => row.elapsedMs)), compactionMs: distribution(runs.map(compactTime)),
		requests: runs.reduce((sum, row) => sum + row.calls.length, 0), summaryRequests: runs.reduce((sum, row) => sum + row.calls.filter(call => call.kind === "summary").length, 0), costUsd: runs.reduce((sum, row) => sum + row.costUsd, 0),
		overflowRuns: runs.filter(row => row.compactions.some(event => event.reason === "overflow")).length,
	}];
}));
const adaptive = rows.filter(row => row.strategy === "adaptive"), pi = rows.filter(row => row.strategy === "pi");
const gate = adaptive.every(row => row.constraintPass) && adaptive.filter(row => row.completed).length >= pi.filter(row => row.completed).length && adaptive.filter(row => row.task.endsWith("exact-evidence")).every(row => row.completed);
const runnerText = await Bun.file(new URL("./context-compaction-benchmark.ts", import.meta.url)).text();
await Bun.write(output, JSON.stringify({ gate, gateScope: "Frozen task-set quality gate only; not a guarantee of semantic fidelity, physical overflow, all providers, or software acceptance.", reportTimeRunnerSha256: createHash("sha256").update(runnerText).digest("hex"), summary, provenance: { implementationHashes: [...implementationHashes], equivalence, returnedModels, recorders: files.map(file => ({ version: file.metadata.recordingVersion ?? "legacy", runnerSha256: file.metadata.runnerSha256 ?? null })), retrievalDetailPolicy: "Legacy recorder parameter/result pairing is not reliable for batched calls. Only aggregate lookup counts and fragment-presence flags are used; raw detail is retained for audit, not pagination evidence. reportTimeRunnerSha256 identifies the script at report time, not historical executions." }, files: files.map(file => ({ metadata: file.metadata, costUsd: file.costUsd, requests: file.requests, rows: file.rows.length })) }, null, 2) + "\n");
console.log(JSON.stringify({ gate, summary }, null, 2));
if (!gate) process.exitCode = 1;
