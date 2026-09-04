import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, RESET_ATTRIBUTES, SHOW_CURSOR, paintDiff } from "./ansi.ts";
import { cloneFrame, type TerminalFrame } from "./frame.ts";
import { KeyDecoder, type Key } from "./keys.ts";

/** Minimal stdin surface; satisfied by NodeJS.ReadStream. */
export interface HostInput {
	setRawMode?(raw: boolean): unknown;
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	off(event: "data", listener: (chunk: Buffer) => void): unknown;
	resume?(): unknown;
	pause?(): unknown;
}

/** Minimal stdout surface; satisfied by NodeJS.WriteStream. */
export interface HostOutput {
	write(text: string): unknown;
	columns?: number | undefined;
	rows?: number | undefined;
}

export interface HostOptions {
	stdin?: HostInput;
	stdout?: HostOutput;
	onKey?: (key: Key) => void;
	onResize?: (columns: number, rows: number) => void;
	/** Emit CSI ?2026 synchronized-update markers around each paint. */
	synchronizedOutput?: boolean;
	/** Milliseconds before a lone ESC resolves to the escape key. */
	escapeDelayMs?: number;
	/** Register process exit/signal handlers; tests pass false to stay inert. */
	trapSignals?: boolean;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * Owns the terminal: alt-screen, raw stdin, resize, differential paint, and
 * restore-on-exit including the crash path (phase 2.2 B1). All visible output
 * goes through paint(frame); nothing else may write to stdout.
 */
export class Host {
	private readonly input: HostInput;
	private readonly output: HostOutput;
	private readonly decoder = new KeyDecoder();
	private readonly onData = (chunk: Buffer) => this.handleData(chunk);
	private readonly onExit = () => this.restoreTerminal();
	private readonly onUncaught = (error: unknown) => {
		this.restoreTerminal();
		console.error(error);
		process.exit(1);
	};
	private readonly onSigwinch = () => this.handleResize();
	private readonly onSigterm = () => {
		this.restoreTerminal();
		process.exit(128 + 15);
	};
	private readonly onSighup = () => {
		this.restoreTerminal();
		process.exit(128 + 1);
	};
	private lastFrame: TerminalFrame | null = null;
	private escapeTimer: ReturnType<typeof setTimeout> | undefined;
	private started = false;

	constructor(private readonly options: HostOptions = {}) {
		this.input = options.stdin ?? process.stdin;
		this.output = options.stdout ?? process.stdout;
	}

	get columns(): number {
		return this.output.columns ?? DEFAULT_COLUMNS;
	}

	get rows(): number {
		return this.output.rows ?? DEFAULT_ROWS;
	}

	get isStarted(): boolean {
		return this.started;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.output.write(ENTER_ALT_SCREEN);
		this.input.setRawMode?.(true);
		this.input.resume?.();
		this.input.on("data", this.onData);
		process.on("SIGWINCH", this.onSigwinch);
		if (this.options.trapSignals ?? true) {
			process.on("exit", this.onExit);
			process.on("uncaughtException", this.onUncaught);
			process.on("SIGTERM", this.onSigterm);
			process.on("SIGHUP", this.onSighup);
		}
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.clearEscapeTimer();
		this.input.off("data", this.onData);
		process.off("SIGWINCH", this.onSigwinch);
		process.off("exit", this.onExit);
		process.off("uncaughtException", this.onUncaught);
		process.off("SIGTERM", this.onSigterm);
		process.off("SIGHUP", this.onSighup);
		this.lastFrame = null;
		this.restoreTerminal();
	}

	/** Differential paint; on any write/encode failure the terminal is restored before rethrowing. */
	paint(frame: TerminalFrame): void {
		if (!this.started) throw new Error("host is not started");
		try {
			const output = paintDiff(this.lastFrame, frame, { synchronized: this.options.synchronizedOutput ?? false });
			if (output.length > 0) this.output.write(output);
			this.lastFrame = cloneFrame(frame);
		} catch (error) {
			this.restoreTerminal();
			throw error;
		}
	}

	private handleData(chunk: Buffer): void {
		for (const key of this.decoder.push(chunk)) this.options.onKey?.(key);
		if (this.decoder.pending) this.armEscapeTimer();
		else this.clearEscapeTimer();
	}

	private handleResize(): void {
		this.lastFrame = null;
		this.options.onResize?.(this.columns, this.rows);
	}

	private armEscapeTimer(): void {
		this.clearEscapeTimer();
		const delay = this.options.escapeDelayMs ?? 25;
		this.escapeTimer = setTimeout(() => {
			this.escapeTimer = undefined;
			for (const key of this.decoder.flush()) this.options.onKey?.(key);
		}, delay);
		if (typeof this.escapeTimer === "object" && "unref" in this.escapeTimer) this.escapeTimer.unref();
	}

	private clearEscapeTimer(): void {
		if (this.escapeTimer !== undefined) {
			clearTimeout(this.escapeTimer);
			this.escapeTimer = undefined;
		}
	}

	private restoreTerminal(): void {
		this.input.setRawMode?.(false);
		this.input.pause?.();
		this.output.write(`${RESET_ATTRIBUTES}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
	}
}
