import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { frameFromLines, serializeTerminalFrame, type ReferenceEnvironmentManifest } from "../packages/tui/src/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/tui-frame.ts");
const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAcCAYAAAATFf3WAAAANklEQVR4nO3OsREAIAADoey/tE7hvQUFPdt2PpcHBAXrgKBgHRAUrAOCgnVAULAOCArWAcGnLoIyW93rX8sfAAAAAElFTkSuQmCC", "base64");

test("tui-frame CLI captures, verifies, and diffs a locked artifact pair", async () => {
	const root = await mkdtemp(join(tmpdir(), "myh-tui-frame-"));
	try {
		const inputs = await writeInputs(root);
		const output = join(root, "artifacts");
		for (const kind of ["reference", "candidate"] as const) {
			const result = await run([
				"capture",
				"--kind", kind,
				"--scenario", "idle",
				"--columns", "4",
				"--rows", "2",
				"--fixture", inputs.fixture,
				"--png", inputs.png,
				"--stream", inputs.stream,
				"--ansi-frame", inputs.ansiFrame,
				"--cell", inputs.cell,
				"--environment", inputs.environment,
				"--output", output,
			]);
			expect(result).toMatchObject({ exitCode: 0, stderr: "" });
			expect(JSON.parse(result.stdout)).toMatchObject({ status: "captured", parityStatus: "eligible" });
		}

		const prefix = (kind: "reference" | "candidate") => join(output, `${kind}-idle`);
		for (const suffix of ["fixture.json", "environment.json", "stream.ansi", "frame.ansi", "cell.json", "png", "manifest.json"]) {
			expect(await Bun.file(`${prefix("reference")}.${suffix}`).exists()).toBe(true);
		}
		expect(await readFile(`${prefix("reference")}.stream.ansi`)).toEqual(await readFile(inputs.stream));

		const manifest = await run(["verify", "manifest", `${prefix("reference")}.manifest.json`, `${prefix("candidate")}.manifest.json`]);
		expect(manifest).toMatchObject({ exitCode: 0 });
		expect(JSON.parse(manifest.stdout)).toEqual({ status: "match" });

		const cells = await run(["diff", "cell", `${prefix("reference")}.cell.json`, `${prefix("candidate")}.cell.json`]);
		expect(cells.exitCode).toBe(0);
		expect(JSON.parse(cells.stdout)).toMatchObject({ equal: true, differingCells: 0 });

		const pixels = await run(["diff", "png", `${prefix("reference")}.png`, `${prefix("candidate")}.png`]);
		expect(pixels.exitCode).toBe(0);
		expect(JSON.parse(pixels.stdout)).toMatchObject({ equal: true, differingPixels: 0, maxChannelDelta: 0 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tui-frame CLI help exits successfully", async () => {
	const result = await run(["--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("--stream <raw-pty-path>");
	expect(result.stderr).toBe("");
});

async function writeInputs(root: string): Promise<Record<"fixture" | "png" | "stream" | "ansiFrame" | "cell" | "environment", string>> {
	const paths = {
		fixture: join(root, "fixture.json"),
		png: join(root, "frame.png"),
		stream: join(root, "stream.ansi"),
		ansiFrame: join(root, "frame.ansi"),
		cell: join(root, "cell.json"),
		environment: join(root, "environment.json"),
	};
	await Promise.all([
		writeFile(paths.fixture, '{"scenario":"idle"}\n'),
		writeFile(paths.png, VALID_PNG),
		writeFile(paths.stream, "\u001b[?1049hA\r\nB\u001b[?25l"),
		writeFile(paths.ansiFrame, "A\nB"),
		writeFile(paths.cell, serializeTerminalFrame(frameFromLines(["A", "B"], 4, 2))),
		writeFile(paths.environment, `${JSON.stringify(environment(), null, 2)}\n`),
	]);
	return paths;
}

function environment(): ReferenceEnvironmentManifest {
	return {
		status: "locked",
		terminal: { name: "test-terminal", version: "1", renderer: "software" },
		os: { name: "linux", version: "1", displayServer: "wayland" },
		font: { path: "/fonts/mono.ttf", sha256: "a".repeat(64), family: "mono", size: 12, lineHeight: 14, weight: 400, hinting: "full", antialiasing: "grayscale" },
		display: { dpi: 96, scale: 1, contentWidthPx: 40, contentHeightPx: 28, cellWidthPx: 10, cellHeightPx: 14, colorProfile: "sRGB" },
		terminalTheme: { name: "test-theme", defaultForeground: "#fff", defaultBackground: "#000", ansi16Sha256: "b".repeat(64), ansi256Sha256: "c".repeat(64), truecolor: true },
		viewport: { columns: 4, rows: 2 },
		runtime: { term: "xterm-256color", colorTerm: "truecolor", locale: "en_US.UTF-8", unicodeWidthPolicy: "pi-tui-0.84.4", timezone: "UTC" },
		cursor: { visible: false, shape: "block", blink: false, phase: 0 },
		determinism: { clock: "2026-09-03T00:00:00Z", animationFrame: 0, randomSeed: 1, fixture: "idle" },
	};
}

async function run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
