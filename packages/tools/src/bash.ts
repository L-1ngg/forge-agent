import { toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";

export interface BashInput {
	command: string;
	timeout_ms?: number;
	max_output_bytes?: number;
}

export interface BashOutput {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

interface OutputBudget {
	remaining: number;
	truncated: boolean;
}

async function collect(stream: ReadableStream<Uint8Array>, budget: OutputBudget): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) {
		if (budget.remaining <= 0) {
			budget.truncated = true;
			continue;
		}
		const retained = chunk.byteLength <= budget.remaining ? chunk : chunk.slice(0, budget.remaining);
		chunks.push(retained);
		budget.remaining -= retained.byteLength;
		if (retained.byteLength < chunk.byteLength) budget.truncated = true;
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export const bashTool: HarnessTool<BashInput, BashOutput> = {
	name: "bash",
	label: "Run command",
	description: "Run one shell command in the working directory with a timeout and a shared stdout/stderr byte limit.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", minLength: 1, description: "Shell command to execute." },
			timeout_ms: { type: "integer", minimum: 1, maximum: 600000, description: "Kill the command after this many milliseconds." },
			max_output_bytes: { type: "integer", minimum: 1024, maximum: 1048576, description: "Maximum combined UTF-8 bytes retained from stdout and stderr." },
		},
		required: ["command"],
		additionalProperties: false,
	},
	async execute(input, context) {
		if (!input.command?.trim()) return toolError("INVALID_ARGUMENT", "command must be a non-empty string", "command", "non-empty shell command", "bun test");
		const timeout = input.timeout_ms ?? 120_000;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) {
			return toolError("INVALID_ARGUMENT", "timeout_ms is outside the supported range", "timeout_ms", "integer from 1 to 600000", "30000");
		}
		const maxBytes = input.max_output_bytes ?? 65_536;
		if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
			return toolError("INVALID_ARGUMENT", "max_output_bytes is outside the supported range", "max_output_bytes", "integer from 1 to 1048576", "65536");
		}
		if (context.signal?.aborted) return toolError("ABORTED", "Command was aborted before it started", "command", "command with a live abort signal", "bun test", true);

		const child = Bun.spawn([process.env.SHELL ?? "/bin/sh", "-lc", input.command], {
			cwd: context.cwd,
			env: { ...process.env, ...context.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		let aborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeout);
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		context.signal?.addEventListener("abort", onAbort, { once: true });
		const budget: OutputBudget = { remaining: maxBytes, truncated: false };
		try {
			const [stdout, stderr, exitCode] = await Promise.all([collect(child.stdout, budget), collect(child.stderr, budget), child.exited]);
			if (aborted) return toolError("ABORTED", "Command was aborted", "command", "command that can complete before cancellation", input.command, true);
			if (timedOut) return toolError("COMMAND_TIMEOUT", `Command exceeded ${timeout}ms`, "timeout_ms", "a timeout long enough for the command", String(Math.min(timeout * 2, 600_000)), true);
			const value: BashOutput = { command: input.command, exitCode, stdout, stderr, truncated: budget.truncated };
			if (exitCode !== 0) {
				return toolError("COMMAND_FAILED", `Command exited with code ${exitCode}: ${stderr || stdout}`.trim(), "command", "command that exits with code 0", "bun test", true);
			}
			return { ok: true, value };
		} finally {
			clearTimeout(timer);
			context.signal?.removeEventListener("abort", onAbort);
		}
	},
};
