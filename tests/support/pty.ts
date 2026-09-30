import { Terminal as ScreenTerminal } from "@xterm/headless";
import { bounded, waitFor } from "./control.ts";

interface PtyOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	columns?: number;
	rows?: number;
	ipc?: (message: unknown) => void;
}

/** Owns the terminal and child together, including failed construction and disposal. */
export class PtyDriver {
	readonly terminal: Bun.Terminal;
	readonly child: Bun.Subprocess;
	private readonly decoder = new TextDecoder();
	private readonly inputs: string[] = [];
	private readonly replies = new Map<number, Record<string, unknown>>();
	private requestId = 0;
	private readonly screen: ScreenTerminal;
	private output = "";
	private closing: Promise<void> | undefined;
	constructor(args: string[], options: PtyOptions = {}) {
		this.screen = new ScreenTerminal({ cols: options.columns ?? 80, rows: options.rows ?? 24, allowProposedApi: true, scrollback: 0 });
		let terminal: Bun.Terminal | undefined;
		try {
			this.terminal = terminal = new Bun.Terminal({ cols: options.columns ?? 80, rows: options.rows ?? 24, data: (_terminal, bytes) => {
				this.output += this.decoder.decode(bytes, { stream: true });
				this.screen.write(bytes);
			} });
			this.child = Bun.spawn([process.execPath, ...args], { terminal: this.terminal, ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env ?? process.env, ipc: message => {
				if (message && typeof message === "object" && "ptyReply" in message && typeof message.ptyReply === "number") this.replies.set(message.ptyReply, message as Record<string, unknown>);
				options.ipc?.(message);
			} });
		} catch (error) {
			try { terminal?.close(); } finally { this.screen.dispose(); }
			throw error;
		}
	}
	get text(): string { return this.output; }
	get screenText(): string { return Array.from({ length: this.screen.rows }, (_, row) => this.screen.buffer.active.getLine(this.screen.buffer.active.baseY + row)?.translateToString(true) ?? "").join("\n"); }
	private flushScreen(): Promise<void> { return new Promise(resolve => this.screen.write("", resolve)); }
	clear(): void { this.output = ""; }
	write(text: string): void { this.inputs.push(text); this.terminal.write(text); }
	resize(columns: number, rows: number): void { this.screen.resize(columns, rows); this.terminal.resize(columns, rows); this.child.kill("SIGWINCH"); }
	async request(command: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.requestId;
		this.child.send({ ptyRequest: id, command, ...fields });
		await this.waitFor(() => this.replies.has(id), `IPC ${command} #${id}`);
		const reply = this.replies.get(id)!; this.replies.delete(id);
		if (reply.error) throw new Error(String(reply.error));
		if (reply.marker) await this.waitFor(() => this.text.includes(String(reply.marker)), `PTY drain #${id}`);
		return reply;
	}
	async send(text: string): Promise<void> {
		await this.request("arm", { bytes: Buffer.from(text).toString("base64") });
		this.write(text);
		await this.request("consumed");
	}
	async capture(): Promise<import("../../packages/tui/src/frame.ts").FrameDump> {
		return (await this.request("capture")).frame as import("../../packages/tui/src/frame.ts").FrameDump;
	}
	async frameText(): Promise<string> {
		await this.request("drain");
		return this.screenText;
	}
	async resizeAndCapture(columns: number, rows: number): Promise<string> {
		this.resize(columns, rows);
		await this.request("resized", { columns, rows });
		return this.frameText();
	}
	async waitFor(check: () => boolean | Promise<boolean>, label = "PTY condition"): Promise<void> {
		await waitFor(async () => {
			await this.flushScreen();
			if (await check()) return true;
			if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Child exited ${this.child.exitCode ?? this.child.signalCode}`);
			return false;
		}, label, { timeoutMs: 6000, diagnostics: () => ({ exitCode: this.child.exitCode, signalCode: this.child.signalCode, inputs: this.inputs.slice(-8), screen: this.screenText, output: this.text.replace(/\x1b\]777;forge-test-\d+\x07/g, "").slice(-1500) }) });
	}
	close(): Promise<void> { return this.closing ??= this.dispose(); }
	private async dispose(): Promise<void> {
		try {
			if (this.child.exitCode === null) this.child.kill("SIGTERM");
			try { await bounded(this.child.exited, "PTY child cleanup", 1000); }
			catch { this.child.kill("SIGKILL"); await bounded(this.child.exited, "PTY forced cleanup", 1000); }
		} finally { try { this.terminal.close(); } finally { this.screen.dispose(); } }
	}
}
