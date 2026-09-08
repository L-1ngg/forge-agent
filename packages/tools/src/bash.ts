import { defineBuiltinTool } from "./define-builtin.ts";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";

export interface BashInput {
	command: string;
	description?: string;
	timeout_ms?: number;
}

export interface BashOutput {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	logPath?: string;
	notice?: string;
}

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

function tailPreview(bytes: Buffer): Buffer {
	let start = Math.max(0, bytes.length - MAX_BYTES);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	let lines = 0;
	for (let index = bytes.length - 1; index >= start; index--) {
		if (bytes[index] === 10 && ++lines === MAX_LINES) { start = index + 1; break; }
	}
	return bytes.subarray(start);
}

interface OutputLog { write(data: Uint8Array): Promise<void>; close(): Promise<void>; }
async function openOutputLog(path: string): Promise<OutputLog> {
	const file = await open(path, "wx", 0o600);
	return { write: async (data) => { await file.writeFile(data); }, close: () => file.close() };
}

export function createBashTool(openLog: (path: string) => Promise<OutputLog> = openOutputLog): HarnessTool<BashInput, BashOutput> {
return defineBuiltinTool<BashInput, BashOutput>({
	name: "bash",
	label: "Run command",
	description: "Run a shell command. Return a combined 2000-line / 50 KiB tail preview; large output is saved to a system temporary log readable with Read.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", minLength: 1, description: "Shell command to execute." },
			description: { type: "string", description: "Short human-readable purpose shown in the tool call title." },
			timeout_ms: { type: "integer", minimum: 1, maximum: 600000, description: "Kill the command after this many milliseconds." },
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
		if (context.signal?.aborted) return toolError("ABORTED", "Command was aborted before it started", "command", "command with a live abort signal", "bun test", true);

		const env = { ...process.env, ...context.env };
		const processGroup = process.platform !== "win32";
		const child = Bun.spawn([env.SHELL ?? "/bin/sh", "-lc", input.command], {
			cwd: context.cwd,
			env,
			detached: processGroup,
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		let aborted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals): void => {
			if (!processGroup) { child.kill(signal); return; }
			try { process.kill(-child.pid, signal); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
			}
		};
		const terminate = (): void => {
			kill("SIGTERM");
			killTimer ??= setTimeout(() => kill("SIGKILL"), 250);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeout);
		const onAbort = () => {
			aborted = true;
			terminate();
		};
		context.signal?.addEventListener("abort", onAbort, { once: true });
		if (context.signal?.aborted) onAbort();
		let preview: Buffer = Buffer.alloc(0);
		let truncated = false;
		let log: OutputLog | undefined;
		let logPath: string | undefined;
		let ioError: unknown;
		let capture = Promise.resolve();
		const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
			try {
				for await (const bytes of stream) {
					if (ioError) break;
					const chunk = Buffer.from(bytes);
					const next = capture.then(async () => {
						if (ioError) return;
						const combined = Buffer.concat([preview, chunk]);
						const tail = tailPreview(combined);
						preview = Buffer.from(tail);
						truncated ||= tail.length < combined.length;
						if (!log && tail.length < combined.length) {
							const path = join(tmpdir(), `forge-bash-${randomUUID()}.log`);
							log = await openLog(path);
							logPath = path;
							await log.write(combined);
						} else if (log) await log.write(chunk);
					});
					capture = next.catch((error: unknown) => { ioError = error; terminate(); });
					await capture;
				}
			} catch (error) { ioError ??= error; terminate(); }
		};
		try {
			const [, , exitCode] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
			await capture;
			try { await log?.close(); } catch (error) { ioError ??= error; }
			const value: BashOutput = {
				command: input.command, exitCode, stdout: preview.toString("utf8"), stderr: "", truncated,
				...(logPath ? { logPath, notice: `Captured output: ${logPath}. Read this temporary file for earlier output.` } : {}),
			};
			const failure = ioError ? toolError("IO_ERROR", `Output capture failed; log may be incomplete: ${ioError instanceof Error ? ioError.message : String(ioError)}`, "command", "writable temporary storage", input.command)
				: aborted ? toolError("ABORTED", "Command was aborted", "command", "live command", input.command, true)
				: timedOut ? toolError("COMMAND_TIMEOUT", `Command exceeded ${timeout}ms`, "timeout_ms", "longer timeout", String(Math.min(timeout * 2, 600000)), true)
				: exitCode !== 0 ? toolError("COMMAND_FAILED", `Command exited with code ${exitCode}`, "command", "command that exits with code 0", input.command, true)
				: undefined;
			if (failure && !failure.ok) return { ...failure, details: { ...value, ...(ioError ? { notice: "Output capture failed. Available output and log are incomplete." } : {}) } };
			return { ok: true, value };
		} finally {
			if (aborted || timedOut || ioError) kill("SIGKILL");
			clearTimeout(timer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			context.signal?.removeEventListener("abort", onAbort);
		}
	},
}, output => output.stdout + output.stderr + (output.notice ? `\n${output.notice}` : ""));
}
export const bashTool = createBashTool();
