import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { withScenario, bounded } from "../../../tests/support/scenario.ts";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";

for (const mode of ["endpoint", "traces-endpoint", "content", "disabled", "unconfigured", "export-error"] as const) {
	test(`CLI OTel ${mode} preserves JSON output and settles export before exit`, () => withScenario(`cli-otel-${mode}`, async s => {
		const enabled = !["disabled", "unconfigured"].includes(mode);
		const task = s.httpFixture("model", [{ id: "task", method: "POST", path: "/v1/messages", match() {}, response: { chunks: [await modelResponse([], "end_turn", "otel cli answer").text()] } }]);
		let spanCount = 0;
		const collector = s.httpFixture("collector", enabled ? [{ id: "export", method: "POST", path: mode === "traces-endpoint" ? "/custom" : "/v1/traces", match(body) {
			const data = z.object({ resourceSpans: z.array(z.object({ resource: z.object({ attributes: z.array(z.object({ key: z.string(), value: z.unknown() })) }), scopeSpans: z.array(z.object({ spans: z.array(z.object({ name: z.string(), traceId: z.string(), spanId: z.string(), attributes: z.array(z.object({ key: z.string(), value: z.unknown() })) })) })) })) }).parse(body);
			const spans = data.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
			spanCount = spans.length;
			expect(spanCount).toBe(2);
			expect(spans.some(span => span.name === "chat claude-sonnet-4-5 #0")).toBe(true);
			expect(JSON.stringify(body)).toContain('"stringValue":"anthropic"');
			expect(data.resourceSpans[0]?.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "forge-cli-fixture" } });
			if (mode === "content") expect(JSON.stringify(body)).toContain("otel cli answer");
			else expect(JSON.stringify(body)).not.toContain("otel cli answer");
		}, response: { status: mode === "export-error" ? 400 : 200, headers: { "content-type": "application/json" }, chunks: ["{}"] } }] : []);
		await mkdir(join(s.cwd, ".forge-agent"));
		await Bun.write(join(s.cwd, ".forge-agent/config.json"), JSON.stringify({ apiKey: "local-test", baseUrl: task.url, memory: { autoUpdate: false } }));
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "-p", "otel cli prompt", "--json", "--no-skills", "--provider", "anthropic", "--model", "claude-sonnet-4-5"], {
			cwd: s.cwd, env: { ...process.env, ...s.env, FORGE_AGENT_API_KEY: "", FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "",
				OTEL_EXPORTER_OTLP_ENDPOINT: mode === "unconfigured" ? "" : collector.url,
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: mode === "traces-endpoint" ? `${collector.url}custom` : "",
				OTEL_SDK_DISABLED: mode === "disabled" ? "true" : "false", OTEL_SERVICE_NAME: "forge-cli-fixture",
				OTEL_EXPORTER_OTLP_TIMEOUT: "1000", OTEL_BSP_SCHEDULE_DELAY: "60000", FORGE_OTEL_CAPTURE_CONTENT: mode === "content" ? "true" : "false",
			}, stdout: "pipe", stderr: "pipe",
		});
		s.defer(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await bounded(child.exited, "otel CLI cleanup"); });
		const [stdout, stderr, code] = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), "otel CLI exit");
		if (code !== 0) throw new Error(`CLI exited ${code}: ${stderr}\n${stdout}`);
		const events = stdout.trim().split("\n").map(line => JSON.parse(line));
		expect(events.some(event => event.type === "message_end" && JSON.stringify(event).includes("otel cli answer"))).toBe(true);
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(collector.count).toBe(enabled ? 1 : 0);
		expect(spanCount).toBe(enabled ? 2 : 0);
	}));
}
