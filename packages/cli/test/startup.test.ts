import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runCli(config: Record<string, unknown>, env: Record<string, string> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "forge-agent-startup-"));
	try {
		await mkdir(join(directory, ".forge-agent"));
		await writeFile(join(directory, ".forge-agent", "config.json"), JSON.stringify(config));
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "--json", "-p", "hello"], {
			cwd: directory,
			env: { ...process.env, XDG_CONFIG_HOME: join(directory, "global"), FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "", FORGE_AGENT_API_KEY: "", XAI_API_KEY: "", ...env },
			stdin: "ignore", stdout: "pipe", stderr: "pipe",
		});
		const timer = setTimeout(() => child.kill(), 5000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			const session = Bun.file(join(directory, ".forge-agent", "session.jsonl"));
			return { stdout, stderr, exitCode, events: stdout.trim().split("\n").map((line) => JSON.parse(line)), session: await session.exists() ? await session.text() : undefined };
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("CLI reports misspelled credential fields as a JSON startup error", async () => {
	const result = await runCli({ provider: "xai", model: "grok-4.6", api_Key: "private-test-key" });
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toBe("");
	expect(result.events).toHaveLength(1);
	expect(result.stdout).toContain("STARTUP_ERROR");
	expect(result.stdout).toContain("api_Key");
	expect(result.stdout).toContain("apiKey");
	expect(result.stdout).not.toContain("private-test-key");
});

test("CLI rejects missing xAI credentials before starting a turn", async () => {
	const result = await runCli({ provider: "xai", model: "grok-4.6" });
	expect(result.exitCode).toBe(1);
	expect(result.events).toHaveLength(1);
	expect(result.stdout).toContain("STARTUP_ERROR");
	expect(result.stdout).toContain("FORGE_AGENT_API_KEY");
	expect(result.stdout).not.toContain("agent_start");
});

for (const credentialSource of ["apiKey", "XAI_API_KEY"] as const) {
	test(`CLI sends xAI ${credentialSource} credentials to the configured Responses endpoint`, async () => {
		const requests: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }> = [];
		const item = { type: "message", id: "msg_local", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello!", annotations: [] }] };
		const events = [
			{ type: "response.created", response: { id: "resp_local" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello!" },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_local", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
		];
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() });
				return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			},
		});
		try {
			const result = await runCli({
				provider: "xai", model: "grok-4.6", baseUrl: new URL("v1", server.url).toString(), thinkingLevel: "off",
				...(credentialSource === "apiKey" ? { apiKey: "test-local-key" } : {}),
			}, credentialSource === "XAI_API_KEY" ? { XAI_API_KEY: "test-local-key" } : {});
			expect(result.exitCode).toBe(0);
			expect(result.session).toContain("Hello!");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ path: "/v1/responses", authorization: "Bearer test-local-key", body: { model: "grok-4.6", stream: true } });
			expect(result.events).toContainEqual(expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "assistant", stopReason: "stop", content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "Hello!" })]) }) }));
		} finally {
			server.stop(true);
		}
	});
}
