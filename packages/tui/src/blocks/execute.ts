import type { BlockEnvelope, ExecuteBlockData } from "@myh/protocol";
import { FoldBlock, type FoldBlockOptions } from "./fold.ts";

export interface ExecuteBlockOptions extends Omit<FoldBlockOptions, "title" | "lines"> {
	id?: string;
	command?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	data?: ExecuteBlockData | BlockEnvelope<"execute">;
}

export class ExecuteBlock extends FoldBlock {
	readonly id: string | undefined;

	constructor(options: ExecuteBlockOptions | string) {
		const normalized = typeof options === "string" ? { command: options } : options;
		const envelope = unwrapEnvelope(normalized.data);
		const data = unwrapData(normalized.data);
		const command = normalized.command ?? data?.command ?? "";
		const stdout = normalized.stdout ?? data?.stdout ?? "";
		const stderr = normalized.stderr ?? data?.stderr ?? "";
		const status = normalized.exitCode ?? data?.exitCode;
		const lines = outputLines(stdout, stderr, status);
		const currentDisplayMode = normalized.currentDisplayMode ?? envelope?.currentDisplayMode;
		const manualOverride = normalized.manualOverride ?? envelope?.manualOverride;
		super({
			...(envelope?.fold ?? {}),
			...normalized,
			title: `execute $ ${command}`,
			lines,
			defaultDisplayMode: normalized.defaultDisplayMode ?? envelope?.defaultDisplayMode ?? envelope?.fold.defaultDisplayMode ?? "truncated",
			...(currentDisplayMode === undefined ? {} : { currentDisplayMode }),
			...(manualOverride === undefined ? {} : { manualOverride }),
			firstLines: normalized.firstLines ?? envelope?.fold.firstLines ?? 2,
			lastLines: normalized.lastLines ?? envelope?.fold.lastLines ?? 3,
		});
		this.id = normalized.id;
	}

	setOutput(output: Pick<ExecuteBlockData, "command" | "stdout" | "stderr" | "exitCode">): void {
		this.title = `execute $ ${output.command}`;
		const lines = outputLines(output.stdout ?? "", output.stderr ?? "", output.exitCode);
		this.setLines(lines);
	}
}

export const Execute = ExecuteBlock;

function unwrapData(value: ExecuteBlockData | BlockEnvelope<"execute"> | undefined): ExecuteBlockData | undefined {
	return value && "data" in value ? value.data : value;
}

function unwrapEnvelope(value: ExecuteBlockData | BlockEnvelope<"execute"> | undefined): BlockEnvelope<"execute"> | undefined {
	return value && "kind" in value && value.kind === "execute" && "fold" in value ? value : undefined;
}

function outputLines(stdout: string, stderr: string, exitCode: number | undefined): string[] {
	return [
		...(stdout ? stdout.split("\n") : []),
		...(stderr ? stderr.split("\n").map((line) => `stderr: ${line}`) : []),
		...(exitCode === undefined ? [] : [`exit: ${exitCode}`]),
	];
}
