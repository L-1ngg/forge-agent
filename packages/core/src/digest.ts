import type { AnyBlockEnvelope, EditBlockData, ExecuteBlockData, FoldBlockData, TextBlockData, ThinkingBlockData } from "@myh/protocol";

export interface DigestOptions {
	maxLength?: number;
}

export const DEFAULT_DIGEST_MAX_LENGTH = 240;

/** Deterministic one-line projection for model context. */
export function digest(value: AnyBlockEnvelope | string | number | boolean | null | undefined | Record<string, unknown>, options: DigestOptions | number = {}): string {
	const maxLength = normalizeLimit(typeof options === "number" ? options : options.maxLength);
	const plain = normalizeLine(stripAnsi(toDigestText(value)));
	if (plain.length <= maxLength) return plain;
	if (maxLength <= 3) return ".".repeat(maxLength);
	return `${plain.slice(0, maxLength - 3).trimEnd()}...`;
}

export const digestRichBlock = digest;

export function digestText(value: string, options: DigestOptions | number = {}): string {
	return digest(value, options);
}

export function digestExecute(value: { command?: string; stdout?: string; stderr?: string; exitCode?: number }, options: DigestOptions | number = {}): string {
	return digest(`execute ${value.command ?? "bash"} ${value.stdout ?? ""} ${value.stderr ?? ""} ${value.exitCode === undefined ? "" : `exit=${value.exitCode}`}`, options);
}

function digestBody(block: AnyBlockEnvelope): string {
	switch (block.kind) {
		case "text":
			return (block.data as TextBlockData).text;
		case "thinking":
			return `thinking: ${(block.data as ThinkingBlockData).markdown}`;
		case "edit":
			return `edit ${(block.data as EditBlockData).path} +${(block.data as EditBlockData).additions}/-${(block.data as EditBlockData).removals}`;
		case "execute": {
			const data = block.data as ExecuteBlockData;
			const output = [data.stdout, data.stderr].filter(Boolean).join(" ");
			const status = data.exitCode === undefined ? "" : ` exit=${data.exitCode}`;
			return `execute ${data.command}${status}${output ? `: ${output}` : ""}`;
		}
		case "fold":
			return `${(block.data as FoldBlockData).title}: ${(block.data as FoldBlockData).lines.join(" ")}`;
	}
}

function isBlock(value: unknown): value is AnyBlockEnvelope {
	return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string" && "data" in value;
}

function toDigestText(value: AnyBlockEnvelope | string | number | boolean | null | undefined | Record<string, unknown>): string {
	if (typeof value === "string") return value;
	if (isBlock(value)) return digestBody(value);
	if (value === null || value === undefined) return "";
	if (typeof value === "object") {
		try {
			return JSON.stringify(sortValue(value)) ?? "";
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)]));
}

function normalizeLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_DIGEST_MAX_LENGTH;
	if (!Number.isFinite(value) || value < 0) throw new RangeError("digest maxLength must be a non-negative finite number");
	return Math.floor(value);
}

function normalizeLine(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

function stripAnsi(value: string): string {
	return value
		.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
		.replace(/[\u001b\u009d].*?(?:\u0007|\u001b\\)/g, "");
}
