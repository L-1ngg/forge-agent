import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic records exercise reporting contracts only, never model quality.
for (const comparison of [false, true]) test(`context report requires every run in its declared strategy set; comparison=${comparison}`, async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-context-report-"));
	const input = join(directory, "input");
	const output = join(directory, "report.json");
	const fixtureText = await Bun.file(new URL("./fixtures/context-tasks-v2.json", import.meta.url)).text();
	const fixture = JSON.parse(fixtureText) as { cases: Array<{ id: string; split: string; port: number; marker: string; target: string }> };
	const strategies = comparison ? ["pi", "adaptive"] : ["adaptive"];
	const rows = fixture.cases.filter(task => task.split === "holdout").flatMap(task => strategies.flatMap(strategy => Array.from({ length: 3 }, (_, repeat) => ({
		task: task.id, repeat, strategy, completed: true, constraintPass: true,
		checks: { noNewEffects: true, deploymentState: true, latestPort: true, exactMarker: true, latestTarget: true, recordedState: true },
		effects: 0, lookupCalls: 1, lookupSuccesses: 1, lookupErrors: 0, requiredFragmentRead: true, evidenceCorrect: true,
		artifact: { deployed: false, port: task.port, marker: task.marker, target: task.target, recorded: true, source: "evidence" },
		response: "", error: "", elapsedMs: 1, totalTokens: 10, measuredTokens: 10, unknownUsageCalls: 0, costUsd: 0,
		calls: [{ kind: "task", usageReported: true, model: "fixture" }], compactions: [],
	}))));
	const data = { metadata: { fixtureSha256: createHash("sha256").update(fixtureText).digest("hex"), model: "fixture", provider: "fixture", split: "holdout", implementationSha256: "fixture", recordingVersion: 3, thinking: "off", contextWindow: 32000, maxTokens: 2048, reserveTokens: 4096, keepRecentTokens: 256, repeats: 3, pricing: {}, ...(comparison ? {} : { strategies }) }, rows, costUsd: 0, requests: rows.length };
	const run = async () => {
		const child = Bun.spawn([process.execPath, "scripts/context-compaction-report.ts", input, output], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { code, stdout, stderr };
	};
	try {
		await Bun.write(join(input, "records.json"), JSON.stringify(data));
		const result = await run(); expect(result.stderr).toBe(""); expect(result.code).toBe(0);
		const report = await Bun.file(output).json();
		expect(report.gate).toBe(true); expect(report.comparisonAvailable).toBe(comparison);
		expect(Object.keys(report.summary).sort()).toEqual(strategies.slice().sort());
		if (!comparison) {
			data.rows[0]!.completed = false; data.rows[0]!.error = "task failed after producing the artifact";
			await Bun.write(join(input, "records.json"), JSON.stringify(data));
			expect((await run()).code).toBe(1); expect((await Bun.file(output).json()).gate).toBe(false);
			data.rows[0]!.completed = true; data.rows[0]!.error = "";
		}
		data.rows.pop();
		await Bun.write(join(input, "records.json"), JSON.stringify(data));
		const incomplete = await run(); expect(incomplete.code).not.toBe(0); expect(incomplete.stderr).toContain("Missing run");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
