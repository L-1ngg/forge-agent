#!/usr/bin/env bun
/** Synthetic cold/warm browsing benchmark; observes real JSONL reads at the filesystem boundary. */
import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "../packages/cli/src/session-host.ts";

const cwd = await fs.mkdtemp(join(tmpdir(), "forge-resume-bench-"));
let host: SessionHost | undefined;
try {
	const directory = join(cwd, ".forge-agent", "sessions");
	await fs.mkdir(directory, { recursive: true });
	for (let i = 0; i < 102; i++) {
		const header = { type: "session", version: 4, id: `session-${i}`, cwd, timestamp: new Date(0).toISOString() };
		const user = { type: "message", id: "user", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", timestamp: 1, content: [{ type: "text", text: `Session ${i}` }] } };
		const assistant = { type: "message", id: "assistant", parentId: "user", timestamp: new Date(2).toISOString(), message: { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: i < 100 ? "recent work" : "x".repeat(10 * 1024 * 1024) }] } };
		await fs.writeFile(join(directory, `${i}.jsonl`), [header, user, assistant].map(value => JSON.stringify(value)).join("\n") + "\n");
	}
	host = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "unused", systemPrompt: "benchmark" });
	const observer = spyOn(fs, "readFile");
	try {
		const measure = async <T>(label: string, operation: () => Promise<T>) => {
			observer.mockClear();
			const start = performance.now();
			const result = await operation();
			console.log(JSON.stringify({ label, ms: Number((performance.now() - start).toFixed(2)), jsonlReads: observer.mock.calls.filter(args => String(args[0]).endsWith(".jsonl")).length }));
			return result;
		};
		const list = await measure("cold list: 100 small + 2 x 10 MiB", () => host!.list());
		await measure("warm list", () => host!.list());
		const id = list.sessions.find(session => session.title === "Session 100")!.id;
		const preview = await measure("cold large preview", () => host!.preview(id));
		await measure("warm large preview", () => host!.preview(id, preview));
	} finally { observer.mockRestore(); }
} finally { await host?.dispose(); await fs.rm(cwd, { recursive: true, force: true }); }
