#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { dumpFrame, type FrameDump } from "../packages/tui/src/frame.ts";
import { compareDumps, unwrapDump, type ReferenceEnvironment } from "../packages/tui/src/parity.ts";
import { paintScenario, SCENARIOS } from "../packages/tui/src/scenarios.ts";
import { App, type AppPort, type AppRequestBus } from "../packages/tui/src/app.ts";

interface Args {
	command: "dump" | "compare" | "dump-scenarios";
	out?: string;
	expected?: string;
	actual?: string;
	manifest?: string;
}

function parseArgs(argv: string[]): Args {
	const command = argv[0];
	if (command !== "dump" && command !== "compare" && command !== "dump-scenarios") {
		throw new Error("usage: tui-frame dump --out FILE | tui-frame dump-scenarios --out DIR | tui-frame compare EXPECTED ACTUAL [--manifest FILE]");
	}
	const args: Args = { command };
	for (let index = 1; index < argv.length; index++) {
		const value = argv[index]!;
		if (value === "--out") args.out = argv[++index];
		else if (value === "--manifest") args.manifest = argv[++index];
		else if (!args.expected) args.expected = value;
		else args.actual = value;
	}
	return args;
}

class NullBus implements AppRequestBus {
	close(): void {}
	async *requests() {}
	async *terminals() {}
	respond(): boolean {
		return false;
	}
}

const emptyPort: AppPort = {
	async *runTurn() {},
};

class MemoryOutput {
	columns = 80;
	rows = 24;
	write(): void {}
}

class MemoryInput {
	setRawMode(): void {}
	on(): void {}
	off(): void {}
	resume(): void {}
	pause(): void {}
}

async function dumpIdle(out: string): Promise<void> {
	const app = new App({
		port: emptyPort,
		host: "alt",
		requestBus: new NullBus(),
		cwd: "/tmp/proj",
		homeDir: "/tmp",
		showWelcome: true,
		stdin: new MemoryInput(),
		stdout: new MemoryOutput(),
		getStatus: () => ({ provider: "faux", model: "faux-1" }),
	});
	await app.start();
	const dump = dumpFrame(app.composeFrameForTest());
	await app.stop();
	await writeFile(out, `${JSON.stringify(dump, null, 2)}\n`);
	console.log(`wrote ${out} (${dump.columns}x${dump.rows})`);
}

async function dumpScenarios(outDir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(outDir, { recursive: true });
	for (const spec of SCENARIOS) {
		const frame = paintScenario(spec);
		const wrapped = {
			scenario: spec.name,
			environment: {
				crateCommit: "forge-agent",
				harnessPatchHash: "candidate",
				rustc: "bun",
				columns: spec.columns,
				rows: spec.rows,
				theme: "GrokNight",
				tick: 0,
				fixtureHash: spec.name,
				timezone: "UTC",
			},
			frame,
		};
		const path = `${outDir}/${spec.name}.json`;
		await writeFile(path, `${JSON.stringify(wrapped)}\n`);
		console.log(`wrote ${path}`);
	}
}

async function compare(expectedPath: string, actualPath: string, manifestPath?: string): Promise<number> {
	const expectedWrapped = unwrapDump(JSON.parse(await readFile(expectedPath, "utf8")));
	const actualWrapped = unwrapDump(JSON.parse(await readFile(actualPath, "utf8")));
	let expectedEnv: ReferenceEnvironment | undefined = expectedWrapped.environment;
	let actualEnv: ReferenceEnvironment | undefined = actualWrapped.environment;
	if (manifestPath) {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { expected: ReferenceEnvironment; actual: ReferenceEnvironment };
		expectedEnv = manifest.expected;
		actualEnv = manifest.actual;
	}
	const verdict = compareDumps(expectedWrapped.frame, actualWrapped.frame, expectedEnv, actualEnv);
	console.log(JSON.stringify(verdict));
	return verdict.status === "equal" ? 0 : 1;
}

const args = parseArgs(Bun.argv.slice(2));
if (args.command === "dump") {
	if (!args.out) throw new Error("dump requires --out");
	process.exit(await dumpIdle(args.out).then(() => 0));
} else if (args.command === "dump-scenarios") {
	if (!args.out) throw new Error("dump-scenarios requires --out");
	process.exit(await dumpScenarios(args.out).then(() => 0));
} else {
	if (!args.expected || !args.actual) throw new Error("compare requires EXPECTED ACTUAL");
	process.exit(await compare(args.expected, args.actual, args.manifest));
}
