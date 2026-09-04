import { createHash } from "node:crypto";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ArtifactKind, ArtifactManifest, ReferenceEnvironmentManifest, TerminalFrame } from "./frame.ts";
import { decodePngRgba, diffFrames, frameFromLines } from "./frame.ts";

export interface CaptureFrameArtifactInput {
	kind: ArtifactKind;
	scenario: string;
	upstreamCommit: string;
	sourceRevision: string;
	environment: ReferenceEnvironmentManifest;
	columns: number;
	rows: number;
	fixture: Uint8Array | string;
	/** Raw bytes written by the TUI process to its PTY. */
	terminalStream: Uint8Array | string;
	/** Final line-oriented ANSI frame exported by the terminal capture. */
	ansiFrame: string;
	frame: TerminalFrame;
	png: Uint8Array;
}

export interface CapturedFrameArtifact {
	frame: TerminalFrame;
	manifest: ArtifactManifest;
	cellFrame: string;
}

export type ArtifactManifestComparison =
	| { status: "match" }
	| { status: "diagnostic"; fields: string[] }
	| { status: "environment-mismatch"; fields: string[] }
	| { status: "manifest-mismatch"; fields: string[] };

/** Create deterministic frame and hash artifacts from a line-oriented ANSI capture. */
export function captureFrameArtifact(input: CaptureFrameArtifactInput): CapturedFrameArtifact {
	requireArtifactKind(input.kind);
	const columns = normalizeDimension(input.columns, "columns");
	const rows = normalizeDimension(input.rows, "rows");
	const frame = validateFrame(input.frame, columns, rows);
	const scenario = requireArtifactId(input.scenario);
	const ansiLines = input.ansiFrame.split(/\r?\n/);
	if (ansiExceedsViewport(ansiLines, columns, rows)) throw new Error("ANSI capture exceeds viewport");
	const ansiFrame = frameFromLines(ansiLines, columns, rows);
	const ansiDiff = diffFrames(ansiFrame, frame);
	if (!ansiDiff.equal) throw new Error(`ANSI frame and cell frame differ at ${ansiDiff.differingCells} cells`);
	const png = decodePngRgba(input.png);
	if (input.environment.status === "locked" && (input.environment.viewport.columns !== columns || input.environment.viewport.rows !== rows)) {
		throw new Error("locked environment viewport does not match capture viewport");
	}
	validateLockedEnvironment(input.environment, scenario, png.width, png.height);
	const cellFrame = serializeTerminalFrame(frame);
	return {
		frame,
		cellFrame,
		manifest: {
			kind: input.kind,
			scenario,
			upstreamCommit: requireText(input.upstreamCommit, "upstreamCommit"),
			sourceRevision: requireText(input.sourceRevision, "sourceRevision"),
			environmentStatus: input.environment.status,
			parityStatus: input.environment.status === "locked" ? "eligible" : "diagnostic",
			environmentSha256: sha256(stableJson(input.environment)),
			columns,
			rows,
			artifacts: {
				fixtureSha256: sha256(input.fixture),
				terminalStreamSha256: sha256(input.terminalStream),
				ansiFrameSha256: sha256(input.ansiFrame),
				cellFrameSha256: sha256(cellFrame),
				pngSha256: sha256(input.png),
			},
		},
	};
}

/** JSON representation used by the CLI and checked into reference artifacts. */
export function serializeTerminalFrame(frame: TerminalFrame): string {
	return `${stableJson(frame)}\n`;
}

export function parseTerminalFrame(source: string): TerminalFrame {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new Error(`invalid terminal frame JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof value !== "object" || value === null) throw new Error("terminal frame must be an object");
	const frame = value as Partial<TerminalFrame>;
	if (!Array.isArray(frame.cells)) throw new Error("terminal frame cells must be an array");
	const columns = normalizeDimension(frame.columns ?? -1, "frame columns");
	const rows = normalizeDimension(frame.rows ?? -1, "frame rows");
	if (frame.cells.length !== rows || frame.cells.some((row) => !Array.isArray(row) || row.length !== columns)) throw new Error("terminal frame dimensions do not match cells");
	return validateFrame(frame as TerminalFrame, columns, rows);
}

/** Verify role, provenance, fixture, viewport, and environment before byte diffs. */
export function compareArtifactManifests(expected: ArtifactManifest, actual: ArtifactManifest): ArtifactManifestComparison {
	const manifestFields: string[] = [];
	if (expected.kind !== "reference") manifestFields.push("expected.kind");
	if (actual.kind !== "candidate") manifestFields.push("actual.kind");
	if (expected.scenario !== actual.scenario) manifestFields.push("scenario");
	if (expected.upstreamCommit !== actual.upstreamCommit) manifestFields.push("upstreamCommit");
	if (expected.sourceRevision !== actual.sourceRevision) manifestFields.push("sourceRevision");
	if (expected.artifacts.fixtureSha256 !== actual.artifacts.fixtureSha256) manifestFields.push("artifacts.fixtureSha256");
	if (manifestFields.length > 0) return { status: "manifest-mismatch", fields: manifestFields };

	const environmentFields: string[] = [];
	if (expected.environmentStatus !== actual.environmentStatus) environmentFields.push("environmentStatus");
	if (expected.environmentSha256 !== actual.environmentSha256) environmentFields.push("environmentSha256");
	if (expected.columns !== actual.columns) environmentFields.push("columns");
	if (expected.rows !== actual.rows) environmentFields.push("rows");
	if (environmentFields.length > 0) return { status: "environment-mismatch", fields: environmentFields };

	const diagnosticFields: string[] = [];
	if (expected.environmentStatus !== "locked" || expected.parityStatus !== "eligible") diagnosticFields.push("expected.parityStatus");
	if (actual.environmentStatus !== "locked" || actual.parityStatus !== "eligible") diagnosticFields.push("actual.parityStatus");
	return diagnosticFields.length > 0 ? { status: "diagnostic", fields: diagnosticFields } : { status: "match" };
}

export function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(typeof value === "string" ? Buffer.from(value) : value).digest("hex");
}

/** Stable JSON hashing keeps manifests reproducible across object insertion order. */
export function stableJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJsonValue(child)]));
}

function validateFrame(frame: TerminalFrame, columns: number, rows: number): TerminalFrame {
	if (frame.columns !== columns || frame.rows !== rows) throw new Error("terminal frame dimensions do not match capture viewport");
	for (const row of frame.cells) {
		for (const cell of row) {
			if (cell === null || typeof cell !== "object" || typeof cell.grapheme !== "string" || ![0, 1, 2].includes(cell.width)) throw new Error("terminal frame contains an invalid cell");
		}
	}
	if (frame.cursor !== undefined) {
		const { x, y, visible, shape } = frame.cursor;
		if (!Number.isInteger(x) || x < 0 || x > columns || !Number.isInteger(y) || y < 0 || y >= rows || typeof visible !== "boolean" || !["block", "underline", "bar"].includes(shape)) {
			throw new Error("terminal frame contains an invalid cursor");
		}
	}
	return frame;
}

function normalizeDimension(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

function requireText(value: string, name: string): string {
	if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
	return value;
}

function requireArtifactId(value: string): string {
	const id = requireText(value, "scenario");
	if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new Error("scenario must be a filesystem-safe artifact id");
	return id;
}

function requireArtifactKind(value: string): asserts value is "reference" | "candidate" {
	if (value !== "reference" && value !== "candidate") throw new Error("kind must be reference or candidate");
}

function ansiExceedsViewport(lines: readonly string[], columns: number, rows: number): boolean {
	for (const [index, line] of lines.entries()) {
		const plain = stripTerminalSequences(line).replaceAll("\r", "");
		if (index >= rows) {
			if (visibleWidth(plain) > 0) return true;
			continue;
		}
		if (visibleWidth(plain) > columns) return true;
	}
	return false;
}

function validateLockedEnvironment(environment: ReferenceEnvironmentManifest, scenario: string, pngWidth: number, pngHeight: number): void {
	if (environment.status !== "locked") return;
	const unknown: string[] = [];
	const requiredText: Array<[string, string]> = [
		["terminal.name", environment.terminal.name],
		["terminal.version", environment.terminal.version],
		["terminal.renderer", environment.terminal.renderer],
		["os.name", environment.os.name],
		["os.version", environment.os.version],
		["os.displayServer", environment.os.displayServer],
		["font.path", environment.font.path],
		["font.family", environment.font.family],
		["font.hinting", environment.font.hinting],
		["font.antialiasing", environment.font.antialiasing],
		["display.colorProfile", environment.display.colorProfile],
		["terminalTheme.name", environment.terminalTheme.name],
		["terminalTheme.defaultForeground", environment.terminalTheme.defaultForeground],
		["terminalTheme.defaultBackground", environment.terminalTheme.defaultBackground],
		["runtime.term", environment.runtime.term],
		["runtime.locale", environment.runtime.locale],
		["runtime.unicodeWidthPolicy", environment.runtime.unicodeWidthPolicy],
		["runtime.timezone", environment.runtime.timezone],
		["determinism.clock", environment.determinism.clock],
	];
	for (const [path, value] of requiredText) {
		if (value.trim().length === 0 || value.trim().toLowerCase() === "unknown" || value.trim().toLowerCase() === "unlocked") unknown.push(path);
	}
	for (const [path, value] of [
		["font.size", environment.font.size],
		["font.lineHeight", environment.font.lineHeight],
		["font.weight", environment.font.weight],
		["display.dpi", environment.display.dpi],
		["display.scale", environment.display.scale],
		["display.contentWidthPx", environment.display.contentWidthPx],
		["display.contentHeightPx", environment.display.contentHeightPx],
		["display.cellWidthPx", environment.display.cellWidthPx],
		["display.cellHeightPx", environment.display.cellHeightPx],
	] as const) {
		if (!Number.isFinite(value) || value <= 0) unknown.push(path);
	}
	for (const [path, value] of [
		["font.sha256", environment.font.sha256],
		["terminalTheme.ansi16Sha256", environment.terminalTheme.ansi16Sha256],
		["terminalTheme.ansi256Sha256", environment.terminalTheme.ansi256Sha256],
	] as const) {
		if (!/^[a-f0-9]{64}$/iu.test(value)) unknown.push(path);
	}
	if (unknown.length > 0) throw new Error(`locked environment has unresolved fields: ${unknown.join(", ")}`);
	if (environment.determinism.fixture !== scenario) throw new Error("locked environment fixture does not match capture scenario");
	if (environment.display.contentWidthPx !== pngWidth || environment.display.contentHeightPx !== pngHeight) {
		throw new Error(`PNG dimensions ${pngWidth}x${pngHeight} do not match locked environment ${environment.display.contentWidthPx}x${environment.display.contentHeightPx}`);
	}
}
