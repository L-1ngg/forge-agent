import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareArtifactManifests, captureFrameArtifact, decodePngRgba, diffFrames, diffRgba, parseTerminalFrame, stableJson, type ArtifactKind, type ArtifactManifest, type ReferenceEnvironmentManifest } from "../packages/tui/src/index.ts";

const DEFAULT_UPSTREAM_COMMIT = "bc7f02eddd3d84085849dc19ed216f11c23b0571";
const DEFAULT_SOURCE_REVISION = "d5a0335a47221e8c9519936cb693e9b6450227ec";

try {
	await main(Bun.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
	const command = argv[0];
	if (command === "--help" || command === "-h" || command === "help") {
		console.log(usage());
		return;
	}
	if (command === "capture") return capture(argv.slice(1));
	if (command === "diff") return diff(argv.slice(1));
	if (command === "verify") return verify(argv.slice(1));
	throw new Error(usage());
}

async function capture(argv: string[]): Promise<void> {
	const kind = parseArtifactKind(requireArg(argv, "--kind"));
	const scenario = requireArg(argv, "--scenario");
	const output = resolve(requireArg(argv, "--output"));
	const fixturePath = resolve(requireArg(argv, "--fixture"));
	const pngPath = resolve(requireArg(argv, "--png"));
	const environmentPath = resolve(optionalArg(argv, "--environment") ?? "packages/tui/test/reference-environment.json");
	const cellPath = resolve(requireArg(argv, "--cell"));
	const streamPath = resolve(requireArg(argv, "--stream"));
	const ansiFramePath = resolve(requireArg(argv, "--ansi-frame"));
	const environment = JSON.parse(await Bun.file(environmentPath).text()) as ReferenceEnvironmentManifest;
	const fixture = await Bun.file(fixturePath).bytes();
	const png = await Bun.file(pngPath).bytes();
	const frame = parseTerminalFrame(await Bun.file(cellPath).text());
	const terminalStream = await Bun.file(streamPath).bytes();
	const ansiFrame = await Bun.file(ansiFramePath).text();
	const columns = parsePositiveInt(requireArg(argv, "--columns"), "columns");
	const rows = parsePositiveInt(requireArg(argv, "--rows"), "rows");
	const artifact = captureFrameArtifact({
		kind,
		scenario,
		upstreamCommit: optionalArg(argv, "--upstream-commit") ?? DEFAULT_UPSTREAM_COMMIT,
		sourceRevision: optionalArg(argv, "--source-revision") ?? DEFAULT_SOURCE_REVISION,
		environment,
		columns,
		rows,
		fixture,
		terminalStream,
		ansiFrame,
		frame,
		png,
	});
	await mkdir(output, { recursive: true });
	const prefix = `${kind}-${scenario}`;
	await writeFile(join(output, `${prefix}.fixture.json`), fixture);
	await writeFile(join(output, `${prefix}.environment.json`), `${stableJson(environment)}\n`);
	await writeFile(join(output, `${prefix}.stream.ansi`), terminalStream);
	await writeFile(join(output, `${prefix}.frame.ansi`), ansiFrame);
	await writeFile(join(output, `${prefix}.cell.json`), artifact.cellFrame);
	await writeFile(join(output, `${prefix}.png`), png);
	await writeFile(join(output, `${prefix}.manifest.json`), `${JSON.stringify(artifact.manifest, null, 2)}\n`);
	console.log(JSON.stringify({
		status: artifact.manifest.parityStatus === "eligible" ? "captured" : "captured-diagnostic",
		parityStatus: artifact.manifest.parityStatus,
		output,
		files: [`${prefix}.fixture.json`, `${prefix}.environment.json`, `${prefix}.stream.ansi`, `${prefix}.frame.ansi`, `${prefix}.cell.json`, `${prefix}.png`, `${prefix}.manifest.json`],
	}, null, 2));
}

async function diff(argv: string[]): Promise<void> {
	const kind = argv[0];
	const expectedPath = resolve(argv[1] ?? "");
	const actualPath = resolve(argv[2] ?? "");
	if (!kind || !argv[1] || !argv[2]) throw new Error(usage());
	if (kind === "cell") {
		const result = diffFrames(parseTerminalFrame(await Bun.file(expectedPath).text()), parseTerminalFrame(await Bun.file(actualPath).text()));
		console.log(JSON.stringify(result, null, 2));
		if (!result.equal) process.exitCode = 1;
		return;
	}
	if (kind === "png") {
		const result = diffRgba(decodePngRgba(await Bun.file(expectedPath).bytes()), decodePngRgba(await Bun.file(actualPath).bytes()));
		console.log(JSON.stringify(result, null, 2));
		if (!result.equal) process.exitCode = 1;
		return;
	}
	throw new Error(`unknown diff kind: ${kind}`);
}

async function verify(argv: string[]): Promise<void> {
	if (argv[0] !== "manifest" || !argv[1] || !argv[2]) throw new Error(usage());
	const expected = JSON.parse(await Bun.file(resolve(argv[1])).text()) as ArtifactManifest;
	const actual = JSON.parse(await Bun.file(resolve(argv[2])).text()) as ArtifactManifest;
	const result = compareArtifactManifests(expected, actual);
	console.log(JSON.stringify(result, null, 2));
	if (result.status !== "match") process.exitCode = 1;
}

function requireArg(argv: string[], flag: string): string {
	const value = optionalArg(argv, flag);
	if (value === undefined || value.length === 0) throw new Error(`missing ${flag}`);
	return value;
}

function parseArtifactKind(value: string): ArtifactKind {
	if (value === "reference" || value === "candidate") return value;
	throw new Error(`invalid --kind: ${value}; expected reference or candidate`);
}

function optionalArg(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index < 0 ? undefined : argv[index + 1];
}

function parsePositiveInt(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function usage(): string {
	return [
		"Usage:",
		"  bun scripts/tui-frame.ts capture --kind <reference|candidate> --scenario <id> --columns <n> --rows <n> --fixture <path> --png <path> --stream <raw-pty-path> --ansi-frame <final-frame-path> --cell <path> --output <dir>",
		"  bun scripts/tui-frame.ts diff cell <reference.cell.json> <candidate.cell.json>",
		"  bun scripts/tui-frame.ts diff png <reference.png> <candidate.png>",
		"  bun scripts/tui-frame.ts verify manifest <reference.manifest.json> <candidate.manifest.json>",
	].join("\n");
}
