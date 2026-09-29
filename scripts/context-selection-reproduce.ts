/** Recompute the frozen v2 experiment without model calls or dependency installation. */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const args = process.argv.slice(2);
let split = "holdout", output: string | undefined;
for (let index = 0; index < args.length; index++) {
	const option = args[index], value = args[++index];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	if (option === "--split") split = value;
	else if (option === "--out") output = resolve(value);
	else throw new Error(`Unknown option: ${option}`);
}
if (!output || !["development", "holdout"].includes(split)) throw new Error("Usage: bun scripts/context-selection-reproduce.ts [--split development|holdout] --out FILE");

const root = fileURLToPath(new URL("../", import.meta.url));
const data = "docs/research/context-selection";
const baseline = "62c7f2574126ad713f30811b74a2abbbccab290b";
// The frozen report hashes these historical paths, including the former Pi port.
const sources = ["context/compact.ts", "context/checkpoint.ts", "context/compaction.ts", "context/read-context.ts", "agent-session.ts", "session-storage.ts", "pi-port.ts"];
const directory = await mkdtemp(join(tmpdir(), "forge-selection-reproduce-"));
const put = async (path: string, content: string | Uint8Array) => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
};
try {
	for (const source of sources) {
		const path = `packages/core/src/${source}`;
		const original = execFileSync("git", ["-C", root, "show", `${baseline}:${path}`]);
		await put(join(directory, "baseline", path), original);
		await put(join(directory, "candidate", path), source === "context/compact.ts" ? await readFile(join(root, data, "candidate-compact-v2.txt")) : original);
	}
	for (const [source, target] of [
		[`${data}/runner-v2.txt`, "scripts/context-selection-benchmark.ts"],
		[`${data}/report-v2.txt`, "scripts/context-selection-report.ts"],
		["scripts/fixtures/context-selection-tasks-v2.json", "scripts/fixtures/context-selection-tasks-v2.json"],
	] as const) await put(join(directory, target), await readFile(join(root, source)));

	const command = [process.execPath, join(directory, "scripts/context-selection-report.ts")];
	const files: string[] = [], preflights: string[] = [];
	for (const variant of ["baseline", "candidate"]) {
		for (const preflight of [false, true]) {
			const path = `${data}/v2-${split}-${preflight ? "preflight-" : ""}${variant}.json`;
			const record = await Bun.file(join(root, path)).json();
			// Relocate only disposable copies. The original script still checks all source hashes.
			record.metadata.sdkRoot = join(directory, variant);
			const copy = join(directory, `${preflight ? "preflight-" : ""}${variant}.json`);
			await put(copy, JSON.stringify(record));
			command.push(`--${preflight ? "preflight-" : ""}${variant}`, copy);
			(preflight ? preflights : files).push(path);
		}
	}
	const reportPath = join(directory, "report.json");
	command.push("--out", reportPath);
	const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
	const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(`Frozen report failed (${code}): ${error}`);
	const report = await Bun.file(reportPath).json();
	const expected = await Bun.file(join(root, data, `v2-${split}-report.json`)).json();
	for (const field of ["gate", "summary", "failures", "provenance"]) {
		if (!isDeepStrictEqual(report[field], expected[field])) throw new Error(`Recomputed ${field} differs from the frozen report`);
	}
	// Point the exported report at durable inputs, not the temporary relocated copies.
	report.files = files;
	report.preflights = preflights;
	await put(output, JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify({ split, gate: report.gate, matchesFrozenReport: true, output }));
} finally {
	await rm(directory, { recursive: true, force: true });
}
