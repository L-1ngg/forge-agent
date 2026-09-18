import { expect, test } from "bun:test";
import { probeConfig, runProbe, type ProbeConfig } from "./live-probe.ts";
import { frames } from "../tests/fixtures/protocol.ts";
import { modelResponse } from "../packages/core/test/helpers/model-response.ts";

test("live probe refuses missing/invalid explicit target and budgets before any request", () => {
	expect(() => probeConfig({})).toThrow("Missing explicit");
	const env = { FORGE_PROBE_PROVIDER: "anthropic", FORGE_PROBE_MODEL: "claude-sonnet-4-5", FORGE_PROBE_API_KEY: "local-only", FORGE_PROBE_BASE_URL: "http://127.0.0.1", FORGE_PROBE_MAX_REQUESTS: "3", FORGE_PROBE_TIMEOUT_MS: "1000" };
	expect(probeConfig(env).maxRequests).toBe(3);
	for (const value of ["0", "-1", "1.5", "Infinity"]) expect(() => probeConfig({ ...env, FORGE_PROBE_MAX_REQUESTS: value })).toThrow("positive integers");
	expect(() => probeConfig({ ...env, FORGE_PROBE_BASE_URL: "https://user:secret@example.invalid" })).toThrow("without credentials");
});

for (const mode of ["pass", "budget", "time", "retry", "auth", "protocol"] as const) test(`live probe local control: ${mode}`, async () => {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		requests++;
		expect(request.headers.get("x-api-key")).toBe("local-only-secret");
		const body = await request.text();
		if (mode === "time") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
		if (mode === "auth") return Response.json({ error: { message: "invalid key" } }, { status: 401 });
		if (mode === "protocol") return new Response("data: {broken\n\n", { headers: { "content-type": "text/event-stream" } });
		if (mode === "retry" && requests === 1) return Response.json({ error: { type: "overloaded_error", message: "temporarily overloaded" } }, { status: 503 });
		if (body.includes("Write a few sentences")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames("anthropic").slice(0, 3).join(""))); } }), { headers: { "content-type": "text/event-stream" } });
		return body.includes("forge-probe-ok") ? modelResponse() : modelResponse([{ id: "probe-1", name: "probe_echo", arguments: { nonce: "forge-probe" } }]);
	} });
	const config: ProbeConfig = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-only-secret", baseUrl: server.url.toString(), maxRequests: mode === "budget" ? 1 : 4, timeoutMs: mode === "time" ? 400 : 4000 };
	try {
		const result = await runProbe(config);
		expect(result.status).toBe(mode === "pass" || mode === "retry" ? "passed" : mode === "budget" ? "budget_exceeded" : mode === "time" ? "timeout" : mode === "auth" ? "authentication" : "protocol_failure");
		expect(result.requests).toBe(requests);
		if (mode === "budget") expect(requests).toBe(1);
		if (mode === "retry") expect(requests).toBe(4);
		if (mode === "pass") expect(requests).toBe(3);
		expect(JSON.stringify(result)).not.toContain("local-only-secret");
	} finally { server.stop(true); }
}, 7000);

test("live probe distinguishes unreachable target from protocol failure", async () => {
	const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const baseUrl = port.url.toString(); port.stop(true);
	const result = await runProbe({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "unused", baseUrl, maxRequests: 2, timeoutMs: 4000 });
	expect(result.status).toBe("environment");
	expect(result.requests).toBeGreaterThan(0);
});
