import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const groups = ["contract", "integration", "cli"] as const;
type Group = typeof groups[number];
export function testGroup(path: string): Group {
	if (path.startsWith("tests/tui-integration/")) return "cli";
	if (path.startsWith("tests/integration/") || path === "scripts/live-probe.test.ts" || /^packages\/core\/test\/(sdk|runtime-|provider-|responses-|context-http|memory-session|compaction-lifecycle|incremental-session|input-ownership)/.test(path)) return "integration";
	return "contract";
}

async function run(command: string[], env: Record<string, string | undefined>, logPath?: string): Promise<number> {
	const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: logPath ? "pipe" : "inherit", stderr: logPath ? "pipe" : "inherit" });
	const writer = logPath ? Bun.file(logPath).writer() : undefined;
	const copy = async (stream: ReadableStream<Uint8Array> | number | undefined | null, output: typeof Bun.stdout) => {
		if (stream && typeof stream !== "number") for await (const chunk of stream) { writer?.write(chunk); await output.write(chunk); }
	};
	const stop = () => child.kill("SIGTERM");
	process.on("SIGINT", stop); process.on("SIGTERM", stop);
	try { const [code] = await Promise.all([child.exited, copy(child.stdout, Bun.stdout), copy(child.stderr, Bun.stderr)]); return code; }
	finally { await writer?.end(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

async function inside(group: string): Promise<number> {
	const directory = join(root, ".test-results");
	await mkdir(directory, { recursive: true });
	if (process.platform === "darwin") {
		if (group === "probe") throw new Error("test:network is Linux-only; macOS verifies fixture compatibility without OS network isolation.");
		const message = "NETWORK_ISOLATION_NOT_ENFORCED darwin: local fixtures and isolated configuration; compatibility evidence only.";
		await Bun.write(join(directory, "network.log"), message + "\n");
		console.log(message);
	} else {
		const probe = await run([process.execPath, "tests/support/network-probe.ts"], process.env, join(directory, "network.log"));
		if (probe !== 0 || group === "probe") return probe;
	}
	if (group === "headless") return run([process.execPath, "scripts/test-headless.ts"], process.env);
	const paths = [...new Bun.Glob("**/*.{js,jsx,ts,tsx}").scanSync({ cwd: root, onlyFiles: true })]
		.filter(path => !path.split("/").some(part => ["node_modules", ".git", "dist"].includes(part)) && /[._](test|spec)\.[jt]sx?$/.test(path)).sort();
	const selected = group === "all" ? groups : groups.filter(value => value === group);
	if (!selected.length) throw new Error(`Unknown test group: ${group}`);
	const timings: unknown[] = [];
	let status = 0;
	for (const current of selected) {
		const files = paths.filter(path => testGroup(path) === current);
		if (!files.length) throw new Error(`Empty test group: ${current}`);
		const start = performance.now();
		const code = await run([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${join(directory, `${current}.xml`)}`, ...files.map(path => `./${path}`)], process.env, join(directory, `${current}.log`));
		const timing = { group: current, files: files.length, elapsedMs: Math.round(performance.now() - start), code, bun: Bun.version, platform: process.platform, arch: process.arch, networkIsolation: process.platform === "linux" ? "network-namespace" : "none" };
		timings.push(timing); console.log(JSON.stringify(timing));
		if (code !== 0) status = code;
	}
	await Bun.write(join(directory, "timings.json"), JSON.stringify(timings, null, 2) + "\n");
	return status;
}

export async function offline(group = "all"): Promise<number> {
	if (!["all", "probe", "headless", ...groups].includes(group)) throw new Error(`Unknown test group: ${group}`);
	const directory = await mkdtemp(join(tmpdir(), "forge-offline-"));
	// Explicit environment: no inherited provider credentials, proxy, NODE_OPTIONS or Bun preload.
	const env: Record<string, string | undefined> = {};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "FORGE_TEST_SEED", "FORGE_TEST_PATH"]) if (process.env[name] !== undefined) env[name] = process.env[name];
	env.XDG_CONFIG_HOME = join(directory, "config"); env.XDG_DATA_HOME = join(directory, "data");
	env.FORGE_TEST_OFFLINE = "1";
	await Promise.all([env.XDG_CONFIG_HOME, env.XDG_DATA_HOME].map(path => mkdir(path!, { recursive: true })));
	const command = [process.execPath, import.meta.path, "--inside", group];
	try {
		if (process.platform === "linux") {
			const available = Bun.spawnSync(["unshare", "--user", "--map-root-user", "--net", "true"], { env, stderr: "ignore" }).exitCode === 0;
			if (available) return await run(["unshare", "--user", "--map-root-user", "--net", "sh", "-c", 'ip link set lo up && exec "$@"', "forge-offline", ...command], env);
			// Ubuntu hosted runners may disallow unprivileged user namespaces. Drop privileges before tests.
			if (!process.env.CI) throw new Error("Offline isolation requires unshare user/network namespaces (or CI sudo). No unsandboxed fallback.");
			const cleanEnvironment = Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [`${key}=${value}`]);
			return await run(["sudo", "-n", "unshare", "--net", "sh", "-c", 'ip link set lo up && uid="$1" && gid="$2" && shift 2 && exec setpriv --reuid "$uid" --regid "$gid" --init-groups -- env -i "$@"', "forge-offline", String(process.getuid!()), String(process.getgid!()), ...cleanEnvironment, ...command], env);
		}
		if (process.platform === "darwin") {
			return await run(command, env);
		}
		throw new Error(`Offline isolation is not supported on ${process.platform}`);
	} finally { await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.main) {
	try { process.exitCode = process.argv[2] === "--inside" ? await inside(process.argv[3] ?? "all") : await offline(process.argv[2]); }
	catch (error) { console.error(error); process.exitCode = 1; }
}
