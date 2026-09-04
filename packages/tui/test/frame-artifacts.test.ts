import { expect, test } from "bun:test";
import { captureFrameArtifact, compareArtifactManifests, frameFromLines, parseTerminalFrame, serializeTerminalFrame, stableJson } from "../src/index.ts";
import type { ReferenceEnvironmentManifest } from "../src/index.ts";

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAcCAYAAAATFf3WAAAANklEQVR4nO3OsREAIAADoey/tE7hvQUFPdt2PpcHBAXrgKBgHRAUrAOCgnVAULAOCArWAcGnLoIyW93rX8sfAAAAAElFTkSuQmCC", "base64");

test("capture artifact hashes raw stream, final frame, cell, fixture, and PNG bytes deterministically", () => {
	const input = {
		kind: "candidate" as const,
		scenario: "idle",
		upstreamCommit: "upstream",
		sourceRevision: "source",
		environment: environment("locked"),
		columns: 4,
		rows: 2,
		fixture: "fixture",
		terminalStream: "\u001b[?1049hraw PTY stream",
		ansiFrame: "A\nB",
		frame: frameFromLines(["A", "B"], 4, 2),
		png: VALID_PNG,
	};
	const first = captureFrameArtifact(input);
	const second = captureFrameArtifact(input);
	expect(first.manifest).toEqual(second.manifest);
	expect(first.cellFrame).toBe(serializeTerminalFrame(first.frame));
	expect(parseTerminalFrame(first.cellFrame)).toEqual(first.frame);
	expect(first.manifest.artifacts.fixtureSha256).toHaveLength(64);
	expect(first.manifest.artifacts.terminalStreamSha256).not.toBe(first.manifest.artifacts.ansiFrameSha256);
	expect(first.manifest).toMatchObject({ kind: "candidate", environmentStatus: "locked", parityStatus: "eligible" });
});

test("artifact manifest comparison requires reference/candidate roles and matching provenance", () => {
	const reference = artifactManifest("reference");
	const candidate = artifactManifest("candidate");
	expect(compareArtifactManifests(reference, candidate)).toEqual({ status: "match" });
	expect(compareArtifactManifests(candidate, reference)).toEqual({
		status: "manifest-mismatch",
		fields: ["expected.kind", "actual.kind"],
	});
	const changed = {
		...candidate,
		upstreamCommit: "different-upstream",
		sourceRevision: "different-source",
		artifacts: { ...candidate.artifacts, fixtureSha256: "different-fixture" },
	};
	expect(compareArtifactManifests(reference, changed)).toEqual({
		status: "manifest-mismatch",
		fields: ["upstreamCommit", "sourceRevision", "artifacts.fixtureSha256"],
	});
});

test("artifact manifest comparison separates environment drift from diagnostic captures", () => {
	const reference = artifactManifest("reference");
	const changed = { ...artifactManifest("candidate"), environmentSha256: "different", rows: 3 };
	expect(compareArtifactManifests(reference, changed)).toEqual({ status: "environment-mismatch", fields: ["environmentSha256", "rows"] });

	const diagnosticReference = artifactManifest("reference", "unlocked");
	const diagnosticCandidate = artifactManifest("candidate", "unlocked");
	expect(compareArtifactManifests(diagnosticReference, diagnosticCandidate)).toEqual({
		status: "diagnostic",
		fields: ["expected.parityStatus", "actual.parityStatus"],
	});
});

test("capture rejects a cell frame that disagrees with the ANSI capture", () => {
	expect(() => captureFrameArtifact({
		kind: "candidate",
		scenario: "idle",
		upstreamCommit: "upstream",
		sourceRevision: "source",
		environment: environment("locked"),
		columns: 4,
		rows: 2,
		fixture: "fixture",
		terminalStream: "raw",
		ansiFrame: "A\nB",
		frame: frameFromLines(["A", "C"], 4, 2),
		png: VALID_PNG,
	})).toThrow("ANSI frame and cell frame differ");
});

test("capture rejects invalid kinds and ANSI content outside the declared viewport", () => {
	const base = {
		scenario: "idle",
		upstreamCommit: "upstream",
		sourceRevision: "source",
		environment: environment("locked"),
		columns: 4,
		rows: 2,
		fixture: "fixture",
		terminalStream: "raw",
		frame: frameFromLines(["A", "B"], 4, 2),
		png: VALID_PNG,
	};
	expect(() => captureFrameArtifact({ ...base, kind: "other" as "reference", ansiFrame: "A\nB" })).toThrow("kind must be reference or candidate");
	expect(() => captureFrameArtifact({ ...base, kind: "candidate", ansiFrame: "ABCDE\nB" })).toThrow("ANSI capture exceeds viewport");
	expect(() => captureFrameArtifact({ ...base, kind: "candidate", ansiFrame: "A\nB\nC" })).toThrow("ANSI capture exceeds viewport");
});

test("capture rejects invalid PNGs and unresolved locked environments", () => {
	const base = {
		kind: "candidate" as const,
		scenario: "idle",
		upstreamCommit: "upstream",
		sourceRevision: "source",
		environment: environment("locked"),
		columns: 4,
		rows: 2,
		fixture: "fixture",
		terminalStream: "raw",
		ansiFrame: "A\nB",
		frame: frameFromLines(["A", "B"], 4, 2),
	};
	expect(() => captureFrameArtifact({ ...base, png: Uint8Array.of(1) })).toThrow("invalid PNG signature");
	expect(() => captureFrameArtifact({
		...base,
		environment: { ...base.environment, font: { ...base.environment.font, sha256: "unknown" } },
		png: VALID_PNG,
	})).toThrow("locked environment has unresolved fields: font.sha256");
	expect(() => captureFrameArtifact({ ...base, scenario: "../idle", png: VALID_PNG })).toThrow("filesystem-safe artifact id");
});

test("stable JSON sorts object keys but preserves array order", () => {
	expect(stableJson({ b: 1, a: { d: 2, c: 3 }, list: [{ z: 1, y: 2 }] })).toBe('{"a":{"c":3,"d":2},"b":1,"list":[{"y":2,"z":1}]}');
});

function artifactManifest(kind: "reference" | "candidate", status: "locked" | "unlocked" = "locked") {
	return captureFrameArtifact({
		kind,
		scenario: "idle",
		upstreamCommit: "upstream",
		sourceRevision: "source",
		environment: environment(status),
		columns: 4,
		rows: 2,
		fixture: "fixture",
		terminalStream: "raw",
		ansiFrame: "A",
		frame: frameFromLines(["A"], 4, 2),
		png: VALID_PNG,
	}).manifest;
}

function environment(status: "locked" | "unlocked"): ReferenceEnvironmentManifest {
	return {
		status,
		terminal: { name: "terminal", version: "1", renderer: "cpu" },
		os: { name: "linux", version: "1", displayServer: "wayland" },
		font: { path: "/fonts/mono.ttf", sha256: "a".repeat(64), family: "mono", size: 12, lineHeight: 14, weight: 400, hinting: "full", antialiasing: "grayscale" },
		display: { dpi: 96, scale: 1, contentWidthPx: 40, contentHeightPx: 28, cellWidthPx: 10, cellHeightPx: 14, colorProfile: "sRGB" },
		terminalTheme: { name: "GrokNight", defaultForeground: "#fff", defaultBackground: "#000", ansi16Sha256: "b".repeat(64), ansi256Sha256: "c".repeat(64), truecolor: true },
		viewport: { columns: 4, rows: 2 },
		runtime: { term: "xterm", colorTerm: "truecolor", locale: "C", unicodeWidthPolicy: "pi-tui", timezone: "UTC" },
		cursor: { visible: false, shape: "block", blink: false, phase: 0 },
		determinism: { clock: "2026-09-03T00:00:00Z", animationFrame: 0, randomSeed: 1, fixture: "idle" },
	};
}
