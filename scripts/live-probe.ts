import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProbeConfig { provider: string; model: string; apiKey: string; baseUrl: string; maxRequests: number; timeoutMs: number; }
export type ProbeStatus = "passed" | "refused" | "budget_exceeded" | "timeout" | "authentication" | "environment" | "protocol_failure";
export interface ProbeResult { status: ProbeStatus; requests: number; elapsedMs: number; httpStatuses: number[]; reason?: string; }

export function probeConfig(env: Record<string, string | undefined>): ProbeConfig {
	const fields = ["PROVIDER", "MODEL", "API_KEY", "BASE_URL", "MAX_REQUESTS", "TIMEOUT_MS"] as const;
	const missing = fields.filter(field => !env[`FORGE_PROBE_${field}`]?.trim());
	if (missing.length) throw new Error(`Missing explicit probe configuration: ${missing.join(", ")}`);
	const maxRequests = Number(env.FORGE_PROBE_MAX_REQUESTS), timeoutMs = Number(env.FORGE_PROBE_TIMEOUT_MS);
	if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Probe request/time budgets must be positive integers");
	const url = new URL(env.FORGE_PROBE_BASE_URL!);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Probe BASE_URL must be an HTTP(S) URL without credentials, query or fragment");
	return { provider: env.FORGE_PROBE_PROVIDER!, model: env.FORGE_PROBE_MODEL!, apiKey: env.FORGE_PROBE_API_KEY!, baseUrl: url.toString(), maxRequests, timeoutMs };
}

/** The proxy counts actual upstream attempts, including adapter/task retries.
 * It is an outer probe budget, not a production SDK request admission API. */
export async function runProbe(config: ProbeConfig): Promise<ProbeResult> {
	const start = performance.now();
	const directory = await mkdtemp(join(tmpdir(), "forge-live-probe-"));
	let requests = 0;
	let stopped: "timeout" | "budget_exceeded" | undefined;
	let transportFailure = false;
	const httpStatuses: number[] = [];
	const abort = new AbortController();
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	const stop = (status: "timeout" | "budget_exceeded") => {
		stopped ??= status; abort.abort(); child?.kill("SIGKILL");
	};
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		if (requests >= config.maxRequests || stopped) { stop("budget_exceeded"); return new Response("Probe request budget exhausted", { status: 429 }); }
		requests++;
		const target = new URL(config.baseUrl);
		target.pathname = target.pathname.replace(/\/$/, "") + new URL(request.url).pathname;
		const headers = new Headers(request.headers);
		for (const name of ["host", "authorization", "x-api-key", "cookie", "content-length"]) headers.delete(name);
		if (config.provider === "anthropic") headers.set("x-api-key", config.apiKey);
		else headers.set("authorization", `Bearer ${config.apiKey}`);
		try {
			const upstream = await fetch(target, { method: request.method, headers, body: await request.arrayBuffer(), signal: AbortSignal.any([abort.signal, request.signal]), redirect: "error" });
			httpStatuses.push(upstream.status);
			return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
		} catch {
			if (!abort.signal.aborted && !request.signal.aborted) transportFailure = true;
			return new Response("Probe upstream unavailable", { status: 502 });
		}
	} });
	const timer = setTimeout(() => stop("timeout"), Math.max(1, config.timeoutMs - (performance.now() - start)));
	try {
		child = Bun.spawn([process.execPath, join(import.meta.dir, "live-probe-worker.ts")], {
			cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), FORGE_PROBE_PROVIDER: config.provider, FORGE_PROBE_MODEL: config.model, FORGE_PROBE_PROXY: server.url.toString() },
		});
		const [output, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		let status: ProbeStatus = stopped ?? (httpStatuses.some(status => status === 401 || status === 403) ? "authentication" : transportFailure || requests === 0 ? "environment" : "protocol_failure");
		if (!stopped && exitCode === 0 && output.trim() === "PROBE_PASSED") status = "passed";
		return { status, requests, elapsedMs: Math.round(performance.now() - start), httpStatuses };
	} finally {
		clearTimeout(timer); abort.abort();
		if (child && child.exitCode === null) child.kill("SIGKILL");
		await child?.exited; server.stop(true); await rm(directory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	let result: ProbeResult;
	try { result = await runProbe(probeConfig(process.env)); }
	catch (error) { result = { status: "refused", requests: 0, elapsedMs: 0, httpStatuses: [], reason: error instanceof Error ? error.message : "Invalid probe configuration" }; }
	console.log(JSON.stringify(result)); process.exitCode = result.status === "passed" ? 0 : 1;
}
