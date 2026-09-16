import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelResponse } from "../../core/test/helpers/model-response.ts";
import { createMemoryHost } from "../src/memory-host.ts";

for (const mode of ["default", "deny-all"] as const) {
	test(`CLI ${mode} permission mode governs automatic memory writes`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-cli-memory-permission-"));
		let requests = 0;
		const bodies: string[] = [];
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
			bodies.push(await request.text());
			return ++requests === 1 ? modelResponse([{ id: "memory-write", name: "write_memory", arguments: { scope: "project", path: "note.md", content: "confirmed note", expectedVersion: null } }]) : modelResponse();
		} });
		try {
			await mkdir(join(directory, ".forge-agent"));
			const store = (await createMemoryHost(directory, join(directory, "data"))).memory;
			await writeFile(join(store.roots.project!, "MEMORY.md"), "EXISTING_MEMORY_INDEX");
			await writeFile(join(directory, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "test-local", baseUrl: server.url.toString(), permissionMode: mode }));
			const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "--json", "-p", "save confirmed note"], { cwd: directory, env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "", FORGE_AGENT_API_KEY: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const timer = setTimeout(() => child.kill(), 5000);
			let output: string;
			try {
				const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
				expect(code).toBe(0); expect(stderr).toBe(""); output = stdout;
			} finally { clearTimeout(timer); }
			if (mode === "deny-all") { expect(await store.list("project")).toEqual(["MEMORY.md"]); expect(output).toContain("deny-all"); }
			else expect((await store.read("project", "note.md")).text).toContain("confirmed note");
			expect(bodies[0]).toContain("EXISTING_MEMORY_INDEX");
			expect(requests).toBe(mode === "deny-all" ? 1 : 2);
		} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
	});
}

test("real CLI retries after a read effect and starts an independent session on restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-cli-runtime-"));
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			requests.push(await request.text());
			if (requests.length === 1) return modelResponse([{ id: "read-once", name: "read", arguments: { path: "input.txt" } }]);
			if (requests.length === 2) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "temporarily overloaded" } }), { status: 529 });
			return modelResponse();
		}
	});
	const run = async () => {
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "--json", "-p", "read input"], { cwd: directory, env: { ...process.env, XDG_CONFIG_HOME: join(directory, "global"), XDG_DATA_HOME: join(directory, "data"), FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "", FORGE_AGENT_API_KEY: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => child.kill(), 5000);
		try { const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect(stderr).toBe(""); return { events: stdout.trim().split("\n").map(line => JSON.parse(line)), code }; }
		finally { clearTimeout(timer); }
	};
	try {
		await mkdir(join(directory, ".forge-agent")); await writeFile(join(directory, "input.txt"), "READ_EFFECT");
		await writeFile(join(directory, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "test-local", baseUrl: server.url.toString(), retry: { baseDelayMs: 0 } }));
		const first = await run(); expect(first.code).toBe(0);
		expect(first.events.filter(event => event.type === "tool_execution_start")).toHaveLength(1);
		expect(first.events.filter(event => event.type === "retry" && event.phase === "scheduled")).toHaveLength(1);
		expect(first.events.at(-1)).toMatchObject({ type: "agent_end", outcome: "success" });
		const second = await run(); expect(second.code).toBe(0); expect(requests).toHaveLength(4); expect(requests[3]).not.toContain("READ_EFFECT");
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
