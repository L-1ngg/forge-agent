#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { dumpFrame, type FrameDump } from "../packages/tui/src/frame.ts";
import { compareDumps, type ReferenceEnvironment } from "../packages/tui/src/parity.ts";
import { App, type AppPort, type AppRequestBus } from "../packages/tui/src/app.ts";

interface Args {
	command: "dump" | "compare";
	out?: string;
	expected?: string;
	actual?: string;
	manifest?: string;
}

function parseArgs(argv: string[]): Args {
	const command = argv[0];
	if (command !== "dump" && command !== "compare") throw new Error("usage: tui-frame dump --out FILE | tui-frame compare EXPECTED ACTUAL [--manifest FILE]");
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

async function compare(expectedPath: string, actualPath: string, manifestPath?: string): Promise<number> {
	const expected = JSON.parse(await readFile(expectedPath, "utf8")) as FrameDump;
	const actual = JSON.parse(await readFile(actualPath, "utf8")) as FrameDump;
	let expectedEnv: ReferenceEnvironment | undefined;
	let actualEnv: ReferenceEnvironment | undefined;
	if (manifestPath) {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { expected: ReferenceEnvironment; actual: ReferenceEnvironment };
		expectedEnv = manifest.expected;
		actualEnv = manifest.actual;
	}
	const verdict = compareDumps(expected, actual, expectedEnv, actualEnv);
	console.log(JSON.stringify(verdict));
	return verdict.status === "equal" ? 0 : 1;
}

const args = parseArgs(Bun.argv.slice(2));
if (args.command === "dump") {
	if (!args.out) throw new Error("dump requires --out");
	process.exit(await dumpIdle(args.out).then(() => 0));
} else {
	if (!args.expected || !args.actual) throw new Error("compare requires EXPECTED ACTUAL");
	process.exit(await compare(args.expected, args.actual, args.manifest));
}
