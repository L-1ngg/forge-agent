import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bounded } from "../tests/support/control.ts";
import { TestEvidence } from "./test-evidence.ts";
import { createTestPlan, groups, registry } from "./test-plan.ts";
import { sourceIdentity } from "./test-source.ts";
export { testGroup } from "./test-plan.ts";

const root = resolve(import.meta.dir, "..");

export async function run(command: string[], env: Record<string, string | undefined>, logPath?: string): Promise<number> {
	if (logPath) await Bun.write(logPath, "");
	const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: logPath ? "pipe" : "inherit", stderr: logPath ? "pipe" : "inherit" });
	const writer = logPath ? Bun.file(logPath).writer() : undefined;
	const copy = async (stream: ReadableStream<Uint8Array> | number | undefined | null, output: typeof Bun.stdout) => {
		if (stream && typeof stream !== "number") for await (const chunk of stream) { writer?.write(chunk); await output.write(chunk); }
	};
	const stop = () => child.kill("SIGTERM");
	process.on("SIGINT", stop); process.on("SIGTERM", stop);
	try { const [code] = await Promise.all([child.exited, copy(child.stdout, Bun.stdout), copy(child.stderr, Bun.stderr)]); return code; }
	catch (error) { child.kill("SIGKILL"); await bounded(child.exited, "failed runner child cleanup"); throw error; }
	finally { await writer?.end(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

async function inside(group: string, directoryPath: string): Promise<number> {
	const evidence = await TestEvidence.resume(directoryPath);
	const directory = evidence.directory;
	let status = 0;
	let failure: string | undefined;
	try {
		const plan = createTestPlan();
		await evidence.setPlan(plan);
		const selected = group === "all" ? groups : groups.filter(value => value === group);
		for (const current of selected) evidence.select(current, plan[current]);
		if (group === "headless") evidence.select("headless", ["packages/cli/test/headless-smoke.test.ts"]);
		if (process.platform === "linux") evidence.select("network", ["tests/support/network-probe.ts"]);
		await evidence.checkpoint();
		if (process.platform === "darwin") {
			if (group === "probe") throw new Error("test:network is Linux-only; macOS verifies fixture compatibility without OS network isolation.");
			const message = "NETWORK_ISOLATION_NOT_ENFORCED darwin: local fixtures and isolated configuration; compatibility evidence only.";
			await Bun.write(join(directory, "network.log"), message + "\n"); console.log(message);
		} else {
			const start = performance.now();
			const probe = await run([process.execPath, "tests/support/network-probe.ts"], process.env, join(directory, "network.log"));
			evidence.record("network", probe, performance.now() - start);
			if (probe !== 0 || group === "probe") { status = probe; return status; }
		}
		if (group === "headless") {
			const start = performance.now();
			status = await run([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${join(directory, "headless.xml")}`, "./packages/cli/test/headless-smoke.test.ts"], process.env, join(directory, "headless.log"));
			evidence.record("headless", status, performance.now() - start); return status;
		}
		for (const current of selected) {
			const files = plan[current], start = performance.now();
			const code = await run([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${join(directory, `${current}.xml`)}`, ...files.map(path => `./${path}`)], process.env, join(directory, `${current}.log`));
			evidence.record(current, code, performance.now() - start);
			await evidence.checkpoint();
			console.log(JSON.stringify({ group: current, files: files.length, code, evidence: directory }));
			if (code !== 0) status = code;
		}
		return status;
	} catch (error) {
		status = 1; failure = error instanceof Error ? error.message : String(error); throw error;
	} finally {
		await evidence.finish(status, failure);
	}
}

export async function offline(group = "all"): Promise<number> {
	if (!["all", "probe", "headless", ...groups].includes(group)) throw new Error(`Unknown test group: ${group}`);
	const evidence = await TestEvidence.open(join(root, ".test-results"), group, registry, { bun: Bun.version, platform: process.platform, arch: process.arch, source: await sourceIdentity(root), networkIsolation: process.platform === "linux" ? "network-namespace" : "none" });
	console.log(JSON.stringify({ selection: group, evidence: evidence.directory }));
	for (const current of group === "all" ? groups : groups.filter(value => value === group)) evidence.select(current, registry[current]);
	if (group === "headless") evidence.select("headless", ["packages/cli/test/headless-smoke.test.ts"]);
	await evidence.checkpoint();
	let directory: string | undefined;
	try {
	directory = await mkdtemp(join(tmpdir(), "forge-offline-"));
	// Explicit environment: no inherited provider credentials, proxy, NODE_OPTIONS or Bun preload.
	const env: Record<string, string | undefined> = {};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "FORGE_TEST_SEED", "FORGE_TEST_PATH"]) if (process.env[name] !== undefined) env[name] = process.env[name];
	// Skills uses ~/.forge/skills; isolate the child home as well as XDG state.
	env.HOME = join(directory, "home");
	env.XDG_CONFIG_HOME = join(directory, "config"); env.XDG_DATA_HOME = join(directory, "data");
	env.FORGE_TEST_OFFLINE = "1";
	await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME].map(path => mkdir(path!, { recursive: true })));
	const command = [process.execPath, import.meta.path, "--inside", group, evidence.directory];
	const launch = async (command: string[]) => {
		const code = await run(command, env, join(evidence.directory, "runner.log"));
		const summary = await Bun.file(join(evidence.directory, "summary.json")).json();
		if (summary.status === "running") { await (await TestEvidence.resume(evidence.directory)).finish(code || 1, `Isolated runner exited ${code} before recording a result`); return code || 1; }
		return code;
	};
		if (process.platform === "linux") {
			const available = Bun.spawnSync(["unshare", "--user", "--map-root-user", "--net", "true"], { env, stderr: "ignore" }).exitCode === 0;
			if (available) return await launch(["unshare", "--user", "--map-root-user", "--net", "sh", "-c", 'ip link set lo up && exec "$@"', "forge-offline", ...command]);
			// Ubuntu hosted runners may disallow unprivileged user namespaces. Drop privileges before tests.
			if (!process.env.CI) throw new Error("Offline isolation requires unshare user/network namespaces (or CI sudo). No unsandboxed fallback.");
			const cleanEnvironment = Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [`${key}=${value}`]);
			return await launch(["sudo", "-n", "unshare", "--net", "sh", "-c", 'ip link set lo up && uid="$1" && gid="$2" && shift 2 && exec setpriv --reuid "$uid" --regid "$gid" --init-groups -- env -i "$@"', "forge-offline", String(process.getuid!()), String(process.getgid!()), ...cleanEnvironment, ...command]);
		}
		if (process.platform === "darwin") {
			return await launch(command);
		}
		throw new Error(`Offline isolation is not supported on ${process.platform}`);
	} catch (error) {
		const current = await TestEvidence.resume(evidence.directory);
		await current.finish(1, error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
		const summary = await Bun.file(join(evidence.directory, "summary.json")).json();
		if (summary.status === "running") await (await TestEvidence.resume(evidence.directory)).finish(1, "Isolated test runner exited before recording a result");
	}
}

if (import.meta.main) {
	try { process.exitCode = process.argv[2] === "--inside" ? await inside(process.argv[3] ?? "all", process.argv[4]!) : await offline(process.argv[2]); }
	catch (error) { console.error(error); process.exitCode = 1; }
}
