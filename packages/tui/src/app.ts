import { response, type RequestEnvelopeUnion, type RequestKind, type ResponseResultByKind } from "@myh/protocol";

export type AppHostMode = "main" | "alt";

/** Structural view of the core request bus; tui may only import @myh/protocol. */
export interface AppRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: unknown): boolean;
}

/** Minimal stdin surface used by the stub; satisfied by NodeJS.ReadStream. */
export interface AppInput {
	setRawMode?(raw: boolean): unknown;
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	off(event: "data", listener: (chunk: Buffer) => void): unknown;
	resume?(): unknown;
	pause?(): unknown;
}

/** Minimal stdout surface used by the stub; satisfied by NodeJS.WriteStream. */
export interface AppOutput {
	write(text: string): unknown;
}

export interface AppOptions {
	/** Agent port; retained for later batches — the B0 stub never runs turns. */
	port: unknown;
	/** Part of the frozen CLI contract; every mode enters alt-screen until B5. */
	host: AppHostMode;
	requestBus: AppRequestBus;
	/** Part of the frozen CLI contract; unused until the B5 input surfaces. */
	completionSource?: unknown;
	getStatus?: () => { provider: string; model: string };
	cwd: string;
	homeDir: string;
	/** Part of the frozen CLI contract; the welcome screen lands in B5. */
	showWelcome?: boolean;
	/** Test seam; defaults to process.stdin / process.stdout. */
	stdin?: AppInput;
	stdout?: AppOutput;
}

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HINT = "myh tui is being rebuilt (phase 2.2 B0). Press q or Ctrl+C to exit; use -p with --json for headless.\r\n";

export class App {
	private readonly input: AppInput;
	private readonly output: AppOutput;
	private readonly requestBus: AppRequestBus;
	private readonly onData = (chunk: Buffer) => this.handleData(chunk);
	private readonly onExit = () => this.restoreTerminal();
	private started = false;
	private stopped: Promise<void> | undefined;
	private resolveStopped: (() => void) | undefined;

	constructor(private readonly options: AppOptions) {
		this.input = options.stdin ?? process.stdin;
		this.output = options.stdout ?? process.stdout;
		this.requestBus = options.requestBus;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.stopped = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		this.output.write(ENTER_ALT_SCREEN);
		this.input.setRawMode?.(true);
		this.input.resume?.();
		this.input.on("data", this.onData);
		process.on("exit", this.onExit);
		this.output.write(HINT);
		void this.respondConservatively();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.input.off("data", this.onData);
		process.off("exit", this.onExit);
		this.restoreTerminal();
		this.resolveStopped?.();
	}

	async waitUntilStopped(): Promise<void> {
		return this.stopped;
	}

	private handleData(chunk: Buffer): void {
		if (chunk.includes(0x03) || chunk.includes(0x71)) void this.stop(); // Ctrl+C or q
	}

	private restoreTerminal(): void {
		this.input.setRawMode?.(false);
		this.input.pause?.();
		this.output.write(LEAVE_ALT_SCREEN);
	}

	/**
	 * Interim responder (phase 2.2 B0-B3): until request cards land in B4,
	 * every request gets the conservative deny/cancel side so a turn can
	 * never hang on a UI that does not exist yet.
	 */
	private async respondConservatively(): Promise<void> {
		try {
			for await (const envelope of this.requestBus.requests()) {
				if (!this.started) return;
				this.requestBus.respond(response(envelope.id, conservativeResultFor(envelope.kind)));
			}
		} catch {
			// A closing bus ends the loop; stop() owns terminal restoration.
		}
	}
}

function conservativeResultFor(kind: RequestKind): ResponseResultByKind[RequestKind] {
	switch (kind) {
		case "permission":
			return { decision: "deny", reason: "interactive request UI is being rebuilt (phase 2.2 B0-B3)" };
		case "plan_approval":
			return { decision: "reject", feedback: "interactive request UI is being rebuilt (phase 2.2 B0-B3)" };
		case "cancel_confirm":
		case "question":
		case "oauth":
			return { decision: "cancel" };
	}
}
