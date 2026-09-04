import { expect, test } from "bun:test";
import { compareArtifactManifests, diffFrames, diffRgba, captureFrameArtifact, type ReferenceEnvironmentManifest } from "../src/index.ts";
import { CANONICAL_COLUMNS, CANONICAL_ROWS, assertCanonicalScenario, canonicalScenarios, renderCanonicalScenario, type CanonicalScenarioRender } from "./render-scenarios.ts";

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAcCAYAAAATFf3WAAAANklEQVR4nO3OsREAIAADoey/tE7hvQUFPdt2PpcHBAXrgKBgHRAUrAOCgnVAULAOCArWAcGnLoIyW93rX8sfAAAAAElFTkSuQmCC", "base64");

test("canonical scenarios render bounded deterministic frames at every required viewport", () => {
	for (const scenario of canonicalScenarios()) {
		for (const columns of CANONICAL_COLUMNS) {
			for (const rows of CANONICAL_ROWS) {
				const first = renderCanonicalScenario(scenario, { columns, rows });
				if (rows === 40) assertCanonicalScenario(first);
				expect(first.frame.columns).toBe(columns);
				expect(first.frame.rows).toBe(rows);
				if (columns === 80 && rows === 24) {
					const second = renderCanonicalScenario(scenario, { columns, rows });
					expect(first.hash).toBe(second.hash);
					expect(diffFrames(first.frame, second.frame)).toMatchObject({ equal: true, differingCells: 0 });
				}
			}
		}
	}
}, 20_000);

test("main and alt hosts share the same canonical frame content", () => {
	const main = renderCanonicalScenario("main-idle", { columns: 80, rows: 24, host: "main" });
	const alt = renderCanonicalScenario("alt-idle", { columns: 80, rows: 24, host: "alt" });
	expect(diffFrames(main.frame, alt.frame)).toMatchObject({ equal: true, differingCells: 0 });
});

test("canonical scenario ids are addressable and use the documented spelling", () => {
	for (const id of ["permission-focused", "question-parked", "cancel-confirm-focused", "plan-approval-focused", "oauth-parked"] as const) {
		expect(() => renderCanonicalScenario(id, { columns: 80, rows: 24 })).not.toThrow();
	}
});

test("semantic golden assertions fail when required content is deleted", () => {
	const rendered = renderCanonicalScenario("user-assistant-markdown", { columns: 80, rows: 24 });
	const broken: CanonicalScenarioRender = {
		...rendered,
		renderedLines: rendered.renderedLines.map((line) => line.replace("Tests pass", "")),
	};
	expect(() => assertCanonicalScenario(broken)).toThrow("missing required text");
});

test("exact cell and RGBA golden checks fail on one changed cell or pixel", () => {
	const rendered = renderCanonicalScenario("idle-empty", { columns: 40, rows: 8 });
	const changedLines = [...rendered.renderedLines];
	changedLines[0] = `${changedLines[0]?.slice(0, -1) ?? ""}x`;
	const changed = renderCanonicalScenario("idle-empty", { columns: 40, rows: 8 });
	const changedFrame = { ...changed.frame, cells: changed.frame.cells.map((row, y) => row.map((cell, x) => y === 0 && x === 0 ? { ...cell, grapheme: cell.grapheme === " " ? "x" : " " } : cell)) };
	expect(diffFrames(rendered.frame, changedFrame)).toMatchObject({ equal: false, differingCells: 1 });
	expect(diffRgba(
		{ width: 1, height: 1, pixels: Uint8Array.of(0, 0, 0, 255) },
		{ width: 1, height: 1, pixels: Uint8Array.of(0, 0, 1, 255) },
	)).toMatchObject({ equal: false, differingPixels: 1, maxChannelDelta: 1 });
	expect(changedLines).not.toEqual(rendered.renderedLines);
});

test("unlocked canonical captures are diagnostic and cannot pass manifest parity", () => {
	const environment = unlockedEnvironment();
	const candidate = renderCanonicalScenario("idle-empty", { columns: 40, rows: 8 });
	const reference = captureFrameArtifact({ kind: "reference", scenario: "idle-empty", upstreamCommit: "upstream", sourceRevision: "source", environment, columns: 40, rows: 8, fixture: candidate.fixtureJson, terminalStream: "reference stream", ansiFrame: candidate.renderedLines.join("\n"), frame: candidate.frame, png: VALID_PNG }).manifest;
	const actual = captureFrameArtifact({ kind: "candidate", scenario: "idle-empty", upstreamCommit: "upstream", sourceRevision: "source", environment, columns: 40, rows: 8, fixture: candidate.fixtureJson, terminalStream: "candidate stream", ansiFrame: candidate.renderedLines.join("\n"), frame: candidate.frame, png: VALID_PNG }).manifest;
	expect(compareArtifactManifests(reference, actual)).toMatchObject({ status: "diagnostic" });
});

function unlockedEnvironment(): ReferenceEnvironmentManifest {
	return {
		status: "unlocked",
		terminal: { name: "unknown", version: "unknown", renderer: "unknown" },
		os: { name: "unknown", version: "unknown", displayServer: "unknown" },
		font: { path: "unknown", sha256: "unknown", family: "unknown", size: 0, lineHeight: 0, weight: 0, hinting: "unknown", antialiasing: "unknown" },
		display: { dpi: 0, scale: 0, contentWidthPx: 0, contentHeightPx: 0, cellWidthPx: 0, cellHeightPx: 0, colorProfile: "unknown" },
		terminalTheme: { name: "unknown", defaultForeground: "unknown", defaultBackground: "unknown", ansi16Sha256: "unknown", ansi256Sha256: "unknown", truecolor: false },
		viewport: { columns: 0, rows: 0 },
		runtime: { term: "unknown", colorTerm: "", locale: "C", unicodeWidthPolicy: "unknown", timezone: "UTC" },
		cursor: { visible: false, shape: "block", blink: false, phase: 0 },
		determinism: { clock: "unlocked", animationFrame: 0, randomSeed: 0, fixture: "unlocked" },
	};
}
