import { SessionCoordinator, type InteractionOptions, type InteractionPort } from "@forge-agent/interaction";
import type { SessionMessage } from "@forge-agent/protocol";
import { editorText } from "./editor.ts";
import { Host, type HostInput, type HostOutput } from "./host.ts";
import type { TerminalFrame } from "./frame.ts";
import { PresentationSession } from "./presentation-session.ts";
import { createTheme, type Theme } from "./theme.ts";

export type {
	InteractionRequestBus as AppRequestBus, InteractionPort as AppPort,
	CompletionSource as AppCompletionSource, SessionView as AppSession,
	InteractionHost as AppSessionHost,
} from "@forge-agent/interaction";
export { formatTokens } from "./presentation-session.ts";
export type AppHostMode = "main" | "alt";
export interface AppOptions<P extends InteractionPort = InteractionPort> extends InteractionOptions<P> {
	openExternal?: (url: string) => Promise<void>;
	host: AppHostMode;
	getStatus?: () => { provider: string; model: string };
	cwd: string;
	homeDir: string;
	showWelcome?: boolean;
	stdin?: HostInput;
	stdout?: HostOutput;
	env?: NodeJS.ProcessEnv;
}

/** Terminal lifetime and presentation activation; business lives in interaction. */
export class App<P extends InteractionPort = InteractionPort> {
	private readonly host: Host;
	private readonly theme: Theme;
	private readonly coordinator: SessionCoordinator<P>;
	private presentation: PresentationSession<P>;
	private readonly savedDrafts = new Map<string, string>();
	private started = false;
	private paintTask: ReturnType<typeof setImmediate> | undefined;
	private stopTask: Promise<void> | undefined;
	private stoppedPromise: Promise<void> | undefined;
	private resolveStopped: (() => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private paintError: unknown;

	constructor(private readonly options: AppOptions<P>) {
		this.coordinator = new SessionCoordinator(options);
		this.theme = createTheme({ ...(options.env ? { env: options.env } : {}) });
		this.host = new Host({
			...(options.stdin ? { stdin: options.stdin } : {}),
			...(options.stdout ? { stdout: options.stdout } : {}),
			synchronizedOutput: true,
			onKey: key => { if (this.started) this.presentation.handleKey(key); },
			onResize: () => this.repaint(),
		});
		this.presentation = this.createPresentation(options.sessions?.current.history ?? options.history ?? [], "", this.coordinator.snapshot().hasHistory);
	}
	private createPresentation(history: readonly SessionMessage[], draft: string, hasHistory?: boolean): PresentationSession<P> {
		return new PresentationSession(this.options, this.host, this.theme, this.coordinator, () => this.repaint(), () => { void this.stop().catch(() => {}); }, history, draft, hasHistory);
	}
	async start(): Promise<void> {
		if (this.started) return;
		if (this.stopTask) throw new Error("App is stopped");
		this.started = true;
		this.stoppedPromise = new Promise(resolve => { this.resolveStopped = resolve; });
		this.unsubscribe = this.coordinator.subscribe(event => {
			if (event.type === "session_activated") {
				if (event.previous?.hasHistory) this.savedDrafts.set(event.previous.id, editorText(this.presentation.draft));
				const draft = event.sessionId ? this.savedDrafts.get(event.sessionId) ?? "" : "";
				if (event.sessionId) this.savedDrafts.delete(event.sessionId);
				this.presentation.dispose();
				this.presentation = this.createPresentation(event.history, draft, event.hasHistory);
				this.repaint();
			} else this.presentation.handleInteraction(event);
		});
		try { this.host.start(); this.coordinator.start(); this.repaint(); }
		catch (error) { await this.stop(); throw error; }
	}
	stop(): Promise<void> {
		if (this.stopTask) return this.stopTask;
		let resolve!: () => void, reject!: (error: unknown) => void;
		this.stopTask = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
		this.started = false;
		if (this.paintTask) clearImmediate(this.paintTask);
		this.paintTask = undefined;
		const close = this.coordinator.close();
		const errors: unknown[] = this.paintError === undefined ? [] : [this.paintError];
		for (const dispose of [() => this.unsubscribe?.(), () => this.presentation.dispose(), () => this.savedDrafts.clear(), () => this.host.stop()]) {
			try { dispose(); } catch (error) { errors.push(error); }
		}
		void close.then(() => {}, error => { errors.push(error); }).then(() => {
			this.resolveStopped?.();
			if (errors.length) reject(new AggregateError(errors, "App stop failed")); else resolve();
		});
		return this.stopTask;
	}
	async waitUntilStopped(): Promise<void> { await this.stoppedPromise; await this.stopTask; }
	private repaint(): void {
		if (!this.started || this.paintTask) return;
		this.paintTask = setImmediate(() => {
			this.paintTask = undefined;
			if (!this.started) return;
			try { this.host.paint(this.presentation.composeFrame()); }
			catch (error) { this.paintError = error; void this.stop().catch(() => {}); }
		});
	}
	composeFrameForTest(): TerminalFrame { return this.presentation.composeFrame(); }
}
