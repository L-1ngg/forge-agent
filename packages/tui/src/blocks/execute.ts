import type { BlockEnvelope, BlockLifecycle, ExecuteBlockData } from "@myh/protocol";
import { FoldBlock, type FoldBlockOptions } from "./fold.ts";
import type { EntryRow } from "../transcript/types.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ExecuteBlockOptions extends Omit<FoldBlockOptions, "title" | "lines"> {
	id?: string;
	command?: string;
	description?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	data?: ExecuteBlockData | BlockEnvelope<"execute">;
}

export class ExecuteBlock extends FoldBlock {
	readonly id: string | undefined;
	private isError = false;
	private lifecycle: BlockLifecycle | undefined;
	private commandText: string;
	private descriptionText: string | undefined;
	private stdoutText: string;
	private stderrText: string;

	constructor(options: ExecuteBlockOptions | string) {
		const normalized = typeof options === "string" ? { command: options } : options;
		const envelope = unwrapEnvelope(normalized.data);
		const data = unwrapData(normalized.data);
		const command = normalized.command ?? data?.command ?? "";
		const description = cleanDescription(normalized.description);
		const stdout = normalized.stdout ?? data?.stdout ?? "";
		const stderr = normalized.stderr ?? data?.stderr ?? "";
		const status = normalized.exitCode ?? data?.exitCode;
		const lines = outputLines(stdout, stderr);
		if (description && command) lines.unshift(`$ ${command}`);
		const lifecycle = normalized.lifecycle ?? envelope?.lifecycle;
		const currentDisplayMode = normalized.currentDisplayMode ?? envelope?.currentDisplayMode;
		const manualOverride = normalized.manualOverride ?? envelope?.manualOverride;
		super({
			...(envelope?.fold ?? {}),
			...normalized,
			title: description ? `Run ${description}` : `Run ${command}`,
			lines,
			defaultDisplayMode: normalized.defaultDisplayMode ?? envelope?.defaultDisplayMode ?? envelope?.fold.defaultDisplayMode ?? "collapsed",
			...(currentDisplayMode === undefined ? {} : { currentDisplayMode }),
			...(manualOverride === undefined ? {} : { manualOverride }),
			firstLines: normalized.firstLines ?? envelope?.fold.firstLines ?? 2,
			lastLines: normalized.lastLines ?? envelope?.fold.lastLines ?? 3,
			colorSlot: normalized.colorSlot ?? envelope?.colorSlot ?? "accent_execute",
		});
		this.id = normalized.id;
		this.lifecycle = lifecycle;
		this.commandText = command;
		this.descriptionText = description;
		this.stdoutText = stdout;
		this.stderrText = stderr;
		this.isError = data?.isError ?? (lifecycle === "failed" || (status !== undefined && status !== 0));
	}

	setOutput(output: Pick<ExecuteBlockData, "command" | "stdout" | "stderr" | "exitCode" | "isError">): void {
		this.commandText = output.command;
		this.stdoutText = output.stdout ?? "";
		this.stderrText = output.stderr ?? "";
		this.title = this.descriptionText ? `Run ${this.descriptionText}` : `Run ${output.command}`;
		this.isError = output.isError ?? (output.exitCode !== undefined && output.exitCode !== 0);
		this.lifecycle = this.isError ? "failed" : "complete";
		const lines = outputLines(output.stdout ?? "", output.stderr ?? "");
		this.setLines(lines);
	}

	/** String rendering is kept for callers outside EntryShell; the shell owns the bullet. */
	override render(width: number): string[] {
		return this.renderEntryRows(Math.max(1, Math.floor(width))).map((row) => truncateToWidth(row.text, Math.max(1, Math.floor(width)), "", false));
	}

	setLifecycle(lifecycle: BlockLifecycle | undefined): void {
		this.lifecycle = lifecycle;
		if (lifecycle === "failed") this.isError = true;
		this.invalidate();
	}

	get lifecycleState(): BlockLifecycle | undefined {
		return this.lifecycle;
	}

	/**
	 * Structured rows for EntryShell.  The hook keeps execute's stdout panel and
	 * error rows as semantic rows instead of flattening them into one ANSI line.
	 */
	renderEntryRows(width: number): readonly EntryRow[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const contentWidth = Math.max(1, safeWidth - 2);
		const headerRows = this.headerRows(contentWidth);
		if (this.fold.displayMode === "collapsed") return headerRows;

		if (this.descriptionText?.trim() && this.commandText.trim()) {
			headerRows.push(...hangingRows("$ ", this.commandText, contentWidth, this.theme.dim, this.theme.cost));
		}

		const outputWidth = Math.max(1, Math.min(safeWidth, Math.max(20, contentWidth - 2)));
		const output = this.semanticOutputRows(outputWidth);
		if (output.length === 0) return headerRows;
		const hasPanel = output.some((row) => row.background === "stdout_panel");
		const visible = this.fold.displayMode === "truncated" && hasPanel
			? trimOutputRows(output, this.firstLines ?? 0, this.lastLines ?? 0, (omitted) => ({ text: this.theme.muted(`… +${omitted} lines`), background: "stdout_panel" }))
			: output;
		return [...headerRows, { text: "" }, ...visible];
	}

	protected override decorateHeader(line: string): string {
		const tone = this.fold.displayMode === "collapsed" ? this.theme.muted : this.theme.status;
		return this.theme.strong(tone(line));
	}

	protected override decorateBodyLine(line: string): string {
		return line;
	}

	protected override formatTruncationMarker(omitted: number): string {
		return `… +${omitted} lines`;
	}

	private semanticOutputRows(width: number): EntryRow[] {
		const rows: EntryRow[] = [];
		const stdout = splitOutput(this.stdoutText).flatMap((line) => wrapAnsiRow(line, width));
		const stderr = splitOutput(this.stderrText).flatMap((line) => wrapAnsiRow(line, width));
		for (const line of stdout) rows.push({ text: line, background: "stdout_panel" });
		if (stderr.length > 0) {
			// Error-only results remain outside the stdout panel. The caller inserts
			// the single separator row shared by output and error bodies.
			if (stdout.length === 0) {
				for (const line of stderr) rows.push({ text: this.theme.error(line) });
			} else {
				for (const line of stderr) rows.push({ text: this.theme.error(line), background: "stdout_panel" });
			}
		}
		return rows;
	}

	private headerRows(width: number): EntryRow[] {
		const collapsed = this.fold.displayMode === "collapsed";
		const tone = collapsed ? this.theme.muted : this.theme.status;
		const title = this.descriptionText?.trim() || this.commandText.trim() || "…";
		const rows = hangingRows("Run ", title, width, (value) => this.theme.strong(tone(value)), tone);
		return collapsed ? [{ text: truncateToWidth(rows[0]?.text ?? "", width, "", false) }] : rows;
	}
}

export const Execute = ExecuteBlock;

function unwrapData(value: ExecuteBlockData | BlockEnvelope<"execute"> | undefined): ExecuteBlockData | undefined {
	return value && "data" in value ? value.data : value;
}

function unwrapEnvelope(value: ExecuteBlockData | BlockEnvelope<"execute"> | undefined): BlockEnvelope<"execute"> | undefined {
	return value && "kind" in value && value.kind === "execute" && "fold" in value ? value : undefined;
}

function outputLines(stdout: string, stderr: string): string[] {
	return [
		...splitOutput(stdout),
		...splitOutput(stderr),
	];
}

/** Terminal output's final newline terminates the last row; it is not a blank row. */
function splitOutput(value: string): string[] {
	const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/u, "");
	return normalized ? normalized.split("\n") : [];
}

function hangingRows(prefix: string, value: string, width: number, prefixColor: (text: string) => string, valueColor: (text: string) => string): EntryRow[] {
	const flat = value.replace(/\s+/gu, " ").trim() || "…";
	const prefixWidth = visibleWidth(prefix);
	const available = Math.max(1, width - prefixWidth);
	const wrapped = wrapAnsiRow(valueColor(flat), available);
	return wrapped.map((text, index) => ({
		text: `${index === 0 ? prefixColor(prefix) : " ".repeat(prefixWidth)}${text}`,
	}));
}

function wrapAnsiRow(row: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return wrapTextWithAnsi(row, safeWidth).map((line) => truncateToWidth(line, safeWidth, "", false));
}

function cleanDescription(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const withoutPrefix = trimmed.replace(/^(?:running|run)(?=\s|$)\s*/iu, "").trim();
	return withoutPrefix || undefined;
}

function trimOutputRows(rows: readonly EntryRow[], first: number, last: number, marker: (omitted: number) => EntryRow): EntryRow[] {
	const head = Math.max(0, Math.floor(first));
	const tail = Math.max(0, Math.floor(last));
	if (rows.length <= head + tail) return [...rows];
	const omitted = rows.length - head - tail;
	return [...rows.slice(0, head), marker(omitted), ...(tail > 0 ? rows.slice(-tail) : [])];
}
