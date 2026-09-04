import { response, type RequestEnvelopeUnion, type RequestKind, type ResponseResultByKind, type SessionEvent } from "@myh/protocol";
import { Host, type HostInput, type HostOutput } from "./host.ts";
import { createFrame, defaultStyle, fillRect, writeText, type CellStyle, type TerminalFrame } from "./frame.ts";
import { computeScreenLayout, layoutOffsets } from "./layout.ts";
import {
	backspace,
	createEditor,
	insertText,
	isEditorEmpty,
	moveDown,
	moveEnd,
	moveHome,
	moveLeft,
	moveRight,
	moveUp,
	submitEditor,
	type EditorState,
} from "./editor.ts";
import { paintComposer, wrapDraft } from "./composer.ts";
import { paintHeader } from "./header.ts";
import { buildStatusSegments, paintStatus } from "./status-line.ts";
import { paintShortcuts, type ShortcutHint } from "./dock.ts";
import { createTheme, type Theme } from "./theme.ts";
import { isCtrlC, type Key } from "./keys.ts";
import { wrapText } from "./width.ts";

export type AppHostMode = "main" | "alt";

/** Structural view of the core request bus; tui may only import @myh/protocol. */
export interface AppRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: unknown): boolean;
}

/** Structural view of the core agent port; AgentRunner satisfies this. */
export interface AppPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
}

export interface AppOptions {
	port: AppPort;
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
	/** Test seams; default to process.stdin / process.stdout / process.env. */
	stdin?: HostInput;
	stdout?: HostOutput;
	env?: NodeJS.ProcessEnv;
}

type TranscriptTone = "user" | "assistant" | "notice" | "error";

interface TranscriptEntry {
	text: string;
	tone: TranscriptTone;
}

const SHORTCUTS_IDLE: readonly ShortcutHint[] = [
	{ keys: ["enter"], label: "send" },
	{ keys: ["ctrl+c"], label: "quit", pinned: true },
];
const SHORTCUTS_RUNNING: readonly ShortcutHint[] = [{ keys: ["ctrl+c"], label: "quit", pinned: true }];

/**
 * Phase 2.2 B2: input skeleton on the own compositor. Turn events render as
 * plain transcript lines until B3 lands the typed-entry projector; request
 * envelopes keep the B0 conservative responder until B4 lands cards.
 */
export class App {
	private readonly host: Host;
	private readonly theme: Theme;
	private readonly draft: EditorState = createEditor();
	private readonly entries: TranscriptEntry[] = [];
	private running = false;
	private started = false;
	private stoppedPromise: Promise<void> | undefined;
	private resolveStopped: (() => void) | undefined;

	constructor(private readonly options: AppOptions) {
		this.theme = createTheme({ ...(options.env ? { env: options.env } : {}) });
		this.host = new Host({
			...(options.stdin ? { stdin: options.stdin } : {}),
			...(options.stdout ? { stdout: options.stdout } : {}),
			synchronizedOutput: true,
			onKey: (key) => this.handleKey(key),
			onResize: () => this.repaint(),
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		this.host.start();
		this.repaint();
		void this.respondConservatively();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.host.stop();
		this.resolveStopped?.();
	}

	async waitUntilStopped(): Promise<void> {
		return this.stoppedPromise;
	}

	private handleKey(key: Key): void {
		if (isCtrlC(key)) {
			void this.stop();
			return;
		}
		switch (key.type) {
			case "char":
				insertText(this.draft, key.text);
				break;
			case "paste":
				// Bracketed paste inserts verbatim; pasted newlines never submit.
				insertText(this.draft, key.text);
				break;
			case "enter":
				this.submit();
				return;
			case "backspace":
				backspace(this.draft);
				break;
			case "arrow":
				if (key.direction === "left") moveLeft(this.draft);
				else if (key.direction === "right") moveRight(this.draft);
				else if (key.direction === "up") moveUp(this.draft);
				else moveDown(this.draft);
				break;
			case "home":
				moveHome(this.draft);
				break;
			case "end":
				moveEnd(this.draft);
				break;
			default:
				return; // escape/tab/unknown have no binding in B2
		}
		this.repaint();
	}

	private submit(): void {
		if (this.running) return; // Enter-queueing lands in B5 (AC-20)
		if (isEditorEmpty(this.draft)) {
			this.repaint();
			return;
		}
		const input = submitEditor(this.draft);
		this.entries.push({ text: `❯ ${input}`, tone: "user" });
		void this.runTurn(input);
		this.repaint();
	}

	private async runTurn(input: string): Promise<void> {
		this.running = true;
		this.repaint();
		try {
			for await (const event of this.options.port.runTurn(input)) this.handleEvent(event);
		} catch (error) {
			this.entries.push({ text: error instanceof Error ? error.message : String(error), tone: "error" });
		} finally {
			this.running = false;
			this.repaint();
		}
	}

	private handleEvent(event: SessionEvent): void {
		switch (event.type) {
			case "message_delta":
				if (event.contentType === "text") this.appendAssistant(event.delta);
				break;
			case "message_end":
				if (event.message.errorMessage) this.entries.push({ text: event.message.errorMessage, tone: "error" });
				break;
			case "tool_execution_start":
				this.entries.push({ text: `▶ ${event.toolName}`, tone: "notice" });
				break;
			case "tool_execution_end":
				if (event.isError) this.entries.push({ text: `✗ ${event.toolName} failed`, tone: "error" });
				break;
			case "turn_end":
				if (event.stopReason === "error" || event.stopReason === "aborted") this.entries.push({ text: `turn ${event.stopReason}`, tone: "error" });
				break;
			default:
				break;
		}
		this.repaint();
	}

	private appendAssistant(delta: string): void {
		const last = this.entries.at(-1);
		if (last && last.tone === "assistant") last.text += delta;
		else this.entries.push({ text: delta, tone: "assistant" });
	}

	private statusSegments(): string[] {
		const status = this.options.getStatus?.();
		return buildStatusSegments({
			...(status ?? {}),
			...(this.running ? { activity: "working" } : {}),
		});
	}

	private repaint(): void {
		if (!this.started) return;
		this.host.paint(this.composeFrame());
	}

	/** Compose the current frame. Pure w.r.t. the terminal; exposed for tests. */
	composeFrameForTest(): TerminalFrame {
		return this.composeFrame();
	}

	private composeFrame(): TerminalFrame {
		const columns = this.host.columns;
		const rows = this.host.rows;
		const frame = createFrame(columns, rows);
		const segments = this.statusSegments();
		const composerLines = Math.max(1, wrapDraft(this.draft, Math.max(1, columns - 6)).lines.length);
		const plan = computeScreenLayout({ columns, rows, composerLines, hasStatus: segments.length > 0 });
		const offsets = layoutOffsets(plan);
		if (plan.header.height === 1) paintHeader(frame, offsets.header, { cwd: this.options.cwd, homeDir: this.options.homeDir }, this.theme);
		paintTranscript(frame, offsets.transcript, plan.transcript.height, this.entries, this.theme);
		paintComposer({
			frame,
			x: 0,
			y: offsets.interactive,
			width: columns,
			height: plan.interactive.height,
			draft: this.draft,
			theme: this.theme,
			caption: this.options.getStatus?.().model,
			placeholder: "Type a message",
			compact: plan.compact,
		});
		if (plan.status.height === 1) paintStatus(frame, offsets.status, segments, this.theme);
		if (plan.shortcuts.height === 1) paintShortcuts(frame, offsets.shortcuts, this.running ? SHORTCUTS_RUNNING : SHORTCUTS_IDLE, this.theme);
		return frame;
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

	private get requestBus(): AppRequestBus {
		return this.options.requestBus;
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

function toneStyle(tone: TranscriptTone, theme: Theme): CellStyle {
	const base = defaultStyle();
	switch (tone) {
		case "user":
			return { ...base, foreground: theme.color("accent_user"), background: theme.color("surface") };
		case "assistant":
			return { ...base, foreground: theme.color("status") };
		case "notice":
			return { ...base, foreground: theme.color("muted") };
		case "error":
			return { ...base, foreground: theme.color("error") };
	}
}

/** Paint transcript entries bottom-aligned in the transcript region. */
export function paintTranscript(frame: TerminalFrame, top: number, height: number, entries: readonly TranscriptEntry[], theme: Theme): void {
	if (height <= 0 || top >= frame.rows) return;
	const rows: { text: string; tone: TranscriptTone }[] = [];
	for (const entry of entries) {
		for (const line of wrapText(entry.text, Math.max(1, frame.columns - 2))) rows.push({ text: line, tone: entry.tone });
	}
	const visible = rows.slice(-height);
	let y = top + height - visible.length;
	for (const row of visible) {
		const style = toneStyle(row.tone, theme);
		if (row.tone === "user") fillRect(frame, 0, y, frame.columns, 1, style);
		writeText(frame, 1, y, row.text, style);
		y++;
	}
}
