import { connect } from "node:net";
import { createSocket } from "node:dgram";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBashTool } from "../../packages/tools/src/bash.ts";
import { bounded } from "./scenario.ts";

// Bun's node:net shim can map ENETUNREACH to ECONNREFUSED; the native probe below
// independently requires an OS policy/routing denial (never a refusal or timeout).
const deniedCodes = new Set(["ENETUNREACH", "EHOSTUNREACH", "EPERM", "EACCES", "ECONNREFUSED"]);
async function tcp(host: string): Promise<void> {
	await bounded(new Promise<void>((resolve, reject) => {
		const socket = connect({ host, port: 443 });
		socket.setTimeout(1000, () => { socket.destroy(); reject(new Error(`No kernel rejection for ${host}`)); });
		socket.once("connect", () => { socket.destroy(); reject(new Error(`External connection allowed: ${host}`)); });
		socket.once("error", error => deniedCodes.has((error as NodeJS.ErrnoException).code ?? "") ? resolve() : reject(error));
	}), `network denial ${host}`);
}
async function udp(): Promise<void> {
	const socket = createSocket("udp4");
	try {
		await bounded(new Promise<void>((resolve, reject) => {
			socket.send("offline-probe", 53, "192.0.2.1", error => error && deniedCodes.has((error as NodeJS.ErrnoException).code ?? "") ? resolve() : reject(new Error(`External UDP was not denied: ${error}`)));
		}), "UDP denial");
	} finally { socket.close(); }
}

async function probe(): Promise<void> {
	if (process.platform !== "linux") throw new Error("Network isolation probes are supported only on Linux.");
	const native = Bun.spawnSync(["python3", "-c", `
import socket, errno
for family, kind, target in [(socket.AF_INET, socket.SOCK_STREAM, ('192.0.2.1',443)), (socket.AF_INET6, socket.SOCK_STREAM, ('2001:db8::1',443)), (socket.AF_INET, socket.SOCK_DGRAM, ('192.0.2.1',53))]:
    with socket.socket(family, kind) as s:
        s.settimeout(1)
        try:
            s.connect(target) if kind == socket.SOCK_STREAM else s.sendto(b'offline-probe', target)
        except OSError as e:
            assert e.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EPERM, errno.EACCES), str(e)
        else:
            raise Exception('External interaction allowed')
`], { stdout: "pipe", stderr: "pipe" });
	if (native.exitCode !== 0) throw new Error(`Native network isolation failed: ${native.stderr.toString()}`);
	await tcp("192.0.2.1"); await tcp("2001:db8::1"); await udp();
	if (process.argv.includes("--child")) { console.log("NETWORK_DENIED"); return; }
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("loopback-ok") });
	const directory = await mkdtemp(join(tmpdir(), "forge-network-probe-"));
	try {
		if (await (await fetch(server.url)).text() !== "loopback-ok") throw new Error("Loopback blocked");
		const child = Bun.spawn([process.execPath, import.meta.path, "--child"], { stdout: "pipe", stderr: "pipe" });
		const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (code !== 0 || !output.includes("NETWORK_DENIED")) throw new Error(`Child network isolation failed: ${error}`);
		const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
		const tool = await createBashTool().execute({ command: `PATH=${quote(process.env.PATH ?? "/usr/bin:/bin")} ${quote(process.execPath)} ${quote(import.meta.path)} --child`, timeout_ms: 5000 }, { cwd: directory, env: { SHELL: "/bin/sh" } });
		if (tool.details?.exitCode !== 0 || !tool.details.stdout.includes("NETWORK_DENIED")) throw new Error(`Tool child isolation failed: ${JSON.stringify(tool)}`);
		await mkdir(join(directory, ".forge-agent"));
		await Bun.write(join(directory, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: "http://192.0.2.1", apiKey: "offline-probe", retry: { enabled: false }, memory: { autoUpdate: false, injection: false } }));
		const cli = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../packages/cli/src/main.ts"), "--json", "-p", "network probe"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => cli.kill("SIGKILL"), 5000);
		try {
			const [out, err, status] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
			if (status === 0 || !/connect|network|unreachable|permission|operation not permitted/i.test(out + err)) throw new Error(`CLI did not fail on network boundary: ${status} ${out} ${err}`);
		} finally { clearTimeout(timer); if (cli.exitCode === null) cli.kill("SIGKILL"); await cli.exited; }
		console.log(`OFFLINE_PROBE_PASS ${process.platform}: loopback HTTP; external IPv4/IPv6 TCP and UDP; inherited Bun/CLI/bash children`);
	} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.main) {
	try { await probe(); } catch (error) { console.error(error); process.exitCode = 1; }
}
