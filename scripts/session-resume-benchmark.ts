#!/usr/bin/env bun
/** Synthetic /resume benchmark; observes production JSONL reads at the filesystem boundary. */
import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionHost } from "../packages/cli/src/session-host.ts";
import { SessionStore } from "../packages/core/src/session-store.ts";
import { messageEntry } from "../packages/core/src/session-storage.ts";

const cwd = await fs.mkdtemp(join(tmpdir(), "forge-resume-bench-"));
let host: SessionHost | undefined;
const samples: Array<Record<string, unknown>> = [];
try {
	const directory = join(cwd, ".forge-agent", "sessions");
	await fs.mkdir(directory, { recursive: true });
	for (let i = 0; i < 102; i++) {
		const long = i >= 100;
		const header = { type: "session", version: 4, id: randomUUID(), cwd, timestamp: new Date(0).toISOString() };
		const userId = randomUUID();
		const user = { type: "message", id: userId, parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", timestamp: 1, content: [{ type: "text", text: `Session ${i}` }] } };
		const assistant = { type: "message", id: randomUUID(), parentId: userId, timestamp: new Date(2).toISOString(), message: { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: long ? "x".repeat(10 * 1024 * 1024) : "recent work" }] } };
		await fs.writeFile(join(directory, `${i}.jsonl`), [header, user, assistant].map(value => JSON.stringify(value)).join("\n") + "\n");
	}
	host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "unused", systemPrompt: "benchmark" });
	const observer = spyOn(fs, "readFile");
	try {
		const measure = async <T>(scenario: string, operation: () => Promise<T>, iterations = 10, warmup = 1) => {
			for (let i = 0; i < warmup; i++) await operation();
			let last: T;
			const runs: Array<{ ms: number; jsonlReads: number }> = [];
			for (let iteration = 0; iteration < iterations; iteration++) {
				observer.mockClear();
				const start = performance.now(); last = await operation();
				const jsonl = observer.mock.calls.filter(args => String(args[0]).endsWith(".jsonl"));
				runs.push({ ms: performance.now() - start, jsonlReads: jsonl.length });
			}
			const times = runs.map(run => run.ms).sort((a, b) => a - b);
			const percentile = (p: number) => times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)]!;
			const middle = Math.floor(times.length / 2);
			const median = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
			const result = { scenario, iterations, warmup, medianMs: Number(median.toFixed(2)), p95Ms: Number(percentile(0.95).toFixed(2)), minMs: Number(times[0]!.toFixed(2)), maxMs: Number(times.at(-1)!.toFixed(2)), jsonlReads: [...new Set(runs.map(run => run.jsonlReads))], runs };
			samples.push(result); console.log(JSON.stringify(result));
			return last!;
		};
		const coldList = async () => { await host!.dispose(); host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "unused", systemPrompt: "benchmark" }); return host.list(); };
		const list = await measure("cold-list-102-sessions", coldList, 10);
		await measure("hot-list-unchanged", () => host!.list(), 10);
		const id = list.sessions.find(session => session.title === "Session 100")?.id;
		if (!id || (await fs.stat(id)).size < 10 * 1024 * 1024) throw new Error("Expected the 10 MiB session fixture");
		const preview = await measure("cold-preview-long-session", () => host!.preview(id), 10);
		await measure("hot-preview-same-revision", () => host!.preview(id, preview), 10);
		const changedStore = await SessionStore.open(id, cwd, { create: false });
		await changedStore.append(messageEntry({ role: "assistant", timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "changed" }] }, changedStore.getLeafId()));
		await measure("changed-list-target-file", () => host!.list(), 1, 0);
		await measure("changed-preview-target-file", () => host!.preview(id, preview), 1, 0);
		const summary = { benchmark: "resume", bun: Bun.version, platform: `${process.platform}-${process.arch}`, sessions: 102, longSessionBytes: 10 * 1024 * 1024, samples };
		console.log(JSON.stringify(summary));
	} finally { observer.mockRestore(); }
} finally { await host?.dispose(); await fs.rm(cwd, { recursive: true, force: true }); }
