import type { ContextUsageSnapshot, RequestEnvelopeUnion, RequestKind, RequestOutcome, ResponseEnvelope, SessionEvent } from "@myh/protocol";
import { Key, Loader, Container, ProcessTerminal, matchesKey, truncateToWidth, visibleWidth, type AutocompleteProvider, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { EscController } from "./esc.ts";
import { Composer, createEditor } from "./editor.ts";
import { FocusStack } from "./focus-stack.ts";
import { HeaderBar, abbreviateHome } from "./header.ts";
import { createTuiHost, type TuiHostMode } from "./host.ts";
import { TranscriptScrollView } from "./scroll.ts";
import { StreamRenderer } from "./stream-renderer.ts";
import { RequestCard, archivedCardLine, requestCardActions, type RequestCardAction, type RequestCardRecord } from "./request-card.ts";
import { createInputAutocompleteProvider, type TuiInputCompletionSource } from "./input/autocomplete.ts";
import { STATUS_SEGMENT_SEPARATOR, StatusLine, type StatusLineState } from "./status-line.ts";
import { canvasStyle, defaultTheme, type SemanticTheme } from "./theme.ts";
import { shortcutRoutes } from "./input-router.ts";
import { renderShortcutHints } from "./dock.ts";
import { ScreenLayout } from "./screen.ts";
import { WelcomeScreen } from "./welcome.ts";

const STOPPED: unique symbol = Symbol("app-stopped");

export interface AppOptions {
	port: TuiAgentPort;
	terminal?: Terminal;
	host?: TuiHostMode;
	onRewind?: () => void;
	requestBus?: TuiRequestBus;
	completionSource?: TuiInputCompletionSource;
	autocompleteProvider?: AutocompleteProvider;
	statusLine?: StatusLine;
	getStatus?: () => StatusLineState;
	theme?: SemanticTheme;
	/** Working directory shown in the header bar; the header stays hidden without it. */
	cwd?: string;
	homeDir?: string;
	/** Mount the deterministic Grok Build welcome page before the agent view. */
	showWelcome?: boolean;
	welcomeVersion?: string;
	onNewWorktree?: () => void;
	onResume?: () => void;
	onChangelog?: () => void;
	onQuit?: () => void;
}

export interface TuiRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: ResponseEnvelope): boolean;
	terminals?(): AsyncIterable<RequestOutcome<RequestKind>>;
	close?(): void;
}

export interface TuiAgentPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	steer(input: string): void;
	followUp(input: string): void;
	abort(): void;
	getUsage?(): ContextUsageSnapshot | undefined;
}

export class App {
	readonly terminal: Terminal;
	readonly tui: TUI;
	readonly renderer: StreamRenderer;
	readonly transcript: TranscriptScrollView;
	readonly editor: ReturnType<typeof createEditor>;
	readonly composer: Composer;
	readonly statusLine: StatusLine;
	readonly header: HeaderBar;
	readonly welcome: WelcomeScreen | undefined;
	readonly focusStack = new FocusStack<RequestCardRecord>();
	private runningTask: Promise<void> | undefined;
	private turnCount = 0;
	private stopped = false;
	private readonly stoppedPromise: Promise<void>;
	private resolveStopped!: () => void;
	private readonly stopSignal: Promise<void>;
	private resolveStopSignal!: () => void;
	private readonly esc = new EscController();
	private readonly blockingCards = new Container();
	private readonly transcriptContent = new Container();
	private readonly workingIndicator: WorkingIndicator;
	private readonly shortcutsBar: Component;
	private readonly agentLayout: ScreenLayout;
	private mountedRoot: Component | undefined;
	private welcomeActive = false;
	private readonly pendingTerminalOutcomes = new Map<string, RequestOutcome<RequestKind>>();
	private requestTask?: Promise<void>;
	private terminalTask?: Promise<void>;
	private requestIterator: AsyncIterator<RequestEnvelopeUnion> | undefined;
	private terminalIterator: AsyncIterator<RequestOutcome<RequestKind>> | undefined;

	constructor(private readonly options: AppOptions) {
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		this.stopSignal = new Promise((resolve) => {
			this.resolveStopSignal = resolve;
		});
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.tui = createTuiHost({ terminal: this.terminal, ...(options.host ? { mode: options.host } : {}) });
		const theme = options.theme ?? defaultTheme;
		this.renderer = new StreamRenderer({ theme, compact: () => this.terminal.rows > 0 && this.terminal.rows <= 20 });
		this.transcriptContent.addChild(this.renderer);
		this.transcript = new TranscriptScrollView(this.transcriptContent, { clipToViewport: true, entrySpans: (width) => this.renderer.getEntrySpans(width) });
		this.header = new HeaderBar({
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
			getUsage: () => options.port.getUsage?.(),
			theme,
		});
		this.statusLine = options.statusLine ?? new StatusLine({
			theme,
			getState: () => {
				// Context metrics live in the header; the status line keeps the rest.
				// Usage from the port is the authoritative truth point for both.
				const { contextTokens: _tokens, contextWindow: _window, contextEstimated: _estimated, ...provided } = {
					...(options.getStatus?.() ?? {}),
					...(options.port.getUsage?.() ?? {}),
				} as StatusLineState;
				const running = provided.running ?? (this.runningTask ? 1 : undefined);
				const turn = provided.turn ?? (this.turnCount > 0 ? this.turnCount : undefined);
				return {
					...provided,
					...(running === undefined ? {} : { running }),
					...(turn === undefined ? {} : { turn }),
				};
			},
		});
		this.shortcutsBar = new FocusShortcutsBar(this.focusStack, theme);
		const autocompleteProvider = options.autocompleteProvider ?? (options.completionSource ? createInputAutocompleteProvider(options.completionSource) : undefined);
		this.editor = createEditor(this.tui, (text) => this.handleEditorSubmit(text), { ...(autocompleteProvider ? { autocompleteProvider } : {}), theme });
		this.composer = new Composer(this.editor, theme, {
			// PromptWidget always has a model caption in agent view. The CLI supplies
			// the live model through getStatus; tests without provider metadata retain
			// the upstream-style explicit unknown label.
			getInfo: () => ({ modelName: options.getStatus?.()?.model?.trim() || "unknown" }),
			compact: this.terminal.rows <= 20,
		});
		this.workingIndicator = new WorkingIndicator(new Loader(this.tui, (value) => theme.activity(value), (value) => theme.muted(value), "Working…"));
		this.agentLayout = new ScreenLayout({
			terminal: this.terminal,
			header: this.header,
			transcript: this.transcript,
			interactive: new InteractiveSlot(this.composer, () => this.visibleCard()),
			interactiveOwner: () => this.focusStack.active || this.focusStack.hasParked ? "card" : "composer",
			status: new StatusDock(this.statusLine, this.workingIndicator),
			shortcuts: this.shortcutsBar,
			canvasStyle: (value: string) => canvasStyle(theme, value),
		});
		this.welcomeActive = options.showWelcome === true;
		this.welcome = this.welcomeActive
			? new WelcomeScreen({
				tui: this.tui,
				composer: this.composer,
				theme,
				location: options.cwd === undefined ? "~" : abbreviateHome(options.cwd, options.homeDir),
				...(options.welcomeVersion === undefined ? {} : { version: options.welcomeVersion }),
				...(options.onNewWorktree === undefined ? {} : { onNewWorktree: options.onNewWorktree }),
				...(options.onResume === undefined ? {} : { onResume: options.onResume }),
				...(options.onChangelog === undefined ? {} : { onChangelog: options.onChangelog }),
				onQuit: options.onQuit ?? (() => { void this.stop(); }),
			})
			: undefined;
		this.mountRoot(this.welcome ?? this.agentLayout);
		this.tui.setFocus(this.welcome ?? this.composer);
		this.tui.addInputListener((data) => {
			if (this.welcomeActive && this.welcome) {
				if (data === "\u0003") {
					void this.stop();
					return { consume: true };
				}
				this.welcome.handleInput(data);
				return { consume: true };
			}
			if (this.focusStack.active) {
				// Card-level Esc/Enter handling is a higher layer than idle rewind;
				// discard any pending idle double-press state when it owns the key.
				this.esc.reset();
				if (matchesKey(data, Key.enter)) {
					this.respondToFocusedCard();
				} else {
					const focusResult = this.focusStack.handleInput(data);
					if (focusResult.card) this.findCard(focusResult.card.id)?.setFocusIndex(focusResult.index);
					if (focusResult.action === "park") {
						if (focusResult.card) this.findCard(focusResult.card.id)?.park();
						this.restoreFocusAfterStackChange();
						this.tui.requestRender();
						return { consume: true };
					}
					this.tui.requestRender();
					return { consume: true };
				}
				this.tui.requestRender();
				return { consume: true };
			}
			if (this.focusStack.hasParked && (data === " " || matchesKey(data, Key.tab) || data === "\t")) {
				const focusResult = this.focusStack.handleInput(data);
				if (focusResult.action === "resume" && focusResult.card) {
					const card = this.findCard(focusResult.card.id);
					card?.resume();
					card?.setFocusIndex(focusResult.index);
					this.tui.setFocus(card ?? this.editor);
					this.tui.requestRender();
					return { consume: true };
				}
			}
			if (this.focusStack.hasParked && data === "\u001b") {
				this.esc.reset();
				return { consume: true };
			}
			if (matchesKey(data, Key.ctrl("o"))) {
				const id = this.renderer.latestFoldableBlockId();
				if (id !== undefined && this.renderer.toggleBlock(id)) this.tui.requestRender();
				return { consume: true };
			}
			// TuiAltScreen owns these bindings itself. The regular host has no
			// viewport router, so route page navigation to our application scroll.
			if (this.tui.mode === "regular") {
				const scrollDelta = matchesKey(data, Key.pageUp) ? -this.scrollPageSize() : matchesKey(data, Key.pageDown) ? this.scrollPageSize() : 0;
				if (scrollDelta !== 0) {
					this.transcript.scrollLines(scrollDelta);
					this.tui.requestRender();
					return { consume: true };
				}
			}
			// A parked card owns ordinary input, but scrollback navigation and fold
			// remain reachable so context can be inspected before resuming it.
			if (this.focusStack.hasParked) return { consume: true };
			if (matchesKey(data, Key.ctrl("enter"))) {
				void this.cancelAndSend();
				return { consume: true };
			}
			if (data === "\u001b") {
				const action = this.esc.press({ hasFocusedCard: this.focusStack.active, running: this.runningTask !== undefined });
				if (action === "abort") this.options.port.abort();
				else if (action === "rewind") this.options.onRewind?.();
				return { consume: true };
			}
			if (data === "\u0003") {
				if (this.runningTask) this.options.port.abort();
				else void this.stop();
				return { consume: true };
			}
			return undefined;
		});
	}

	async start(): Promise<void> {
		this.tui.start();
		if (this.options.requestBus) {
			this.requestTask = this.consumeRequests(this.options.requestBus);
			if (this.options.requestBus.terminals) this.terminalTask = this.consumeTerminals(this.options.requestBus);
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		let failure: { error: unknown } | undefined;
		const captureFailure = (action: () => void): void => {
			try {
				action();
			} catch (error) {
				failure ??= { error };
			}
		};
		// Cleanup is best-effort as a whole: one synchronous teardown failure must
		// not strand the async consumers or leave waitUntilStopped() unresolved.
		captureFailure(() => this.workingIndicator.stop());
		captureFailure(() => this.tui.stop());
		captureFailure(() => this.options.requestBus?.close?.());
		this.closeIterator(this.requestIterator);
		this.closeIterator(this.terminalIterator);
		this.resolveStopSignal();
		try {
			await Promise.allSettled([this.requestTask, this.terminalTask].filter((task): task is Promise<void> => task !== undefined));
		} finally {
			this.pendingTerminalOutcomes.clear();
			this.resolveStopped();
		}
		if (failure) throw failure.error;
	}

	waitUntilStopped(): Promise<void> {
		return this.stoppedPromise;
	}

	private async submit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) return;
		if (this.runningTask) {
			this.options.port.followUp(input);
			return;
		}
		this.turnCount++;
		const task = this.run(input);
		this.runningTask = task;
		this.workingIndicator.start();
		try {
			await task;
		} finally {
			if (this.runningTask === task) this.runningTask = undefined;
			this.workingIndicator.stop();
			this.tui.requestRender();
		}
	}

	private handleEditorSubmit(text: string): void {
		if (!text.trim()) return;
		if (this.welcomeActive) this.activateAgentScreen();
		void this.submit(text);
	}

	private activateAgentScreen(): void {
		if (!this.welcomeActive) return;
		this.welcomeActive = false;
		this.mountRoot(this.agentLayout);
		this.tui.setFocus(this.composer);
		this.tui.requestRender();
	}

	private mountRoot(root: Component): void {
		if (this.mountedRoot === root) return;
		if ("setLayoutRoot" in this.tui && typeof this.tui.setLayoutRoot === "function") {
			this.tui.setLayoutRoot(root);
		} else {
			if (this.mountedRoot) this.tui.removeChild(this.mountedRoot);
			this.tui.addChild(root);
		}
		this.mountedRoot = root;
	}

	private async cancelAndSend(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;
		const previous = this.runningTask;
		if (previous) {
			this.esc.markCancelled();
			this.options.port.abort();
			await previous;
		}
		this.editor.setText("");
		await this.submit(text);
	}

	private async run(input: string): Promise<void> {
		for await (const event of this.options.port.runTurn(input)) this.apply(event);
	}

	private async consumeRequests(requestBus: TuiRequestBus): Promise<void> {
		const iterator = requestBus.requests()[Symbol.asyncIterator]();
		this.requestIterator = iterator;
		try {
			for (;;) {
				const next = await this.nextWhileRunning(iterator);
				if (next === STOPPED || next.done || this.stopped) return;
				const request = next.value;
				const card = new RequestCard(request, this.options.theme ?? defaultTheme);
				this.blockingCards.addChild(card);
				this.focusStack.push(card.record);
				card.setFocusIndex(this.focusStack.focusIndex);
				const terminal = this.pendingTerminalOutcomes.get(request.id);
				if (terminal) {
					this.pendingTerminalOutcomes.delete(request.id);
					this.retireCard(card, terminal);
				} else {
					this.tui.setFocus(card);
				}
				this.tui.requestRender();
			}
		} finally {
			if (this.requestIterator === iterator) this.requestIterator = undefined;
		}
	}

	private async consumeTerminals(requestBus: TuiRequestBus): Promise<void> {
		const terminals = requestBus.terminals;
		if (!terminals) return;
		const iterator = terminals.call(requestBus)[Symbol.asyncIterator]();
		this.terminalIterator = iterator;
		try {
			for (;;) {
				const next = await this.nextWhileRunning(iterator);
				if (next === STOPPED || next.done || this.stopped) return;
				const outcome = next.value;
				const card = this.findCard(outcome.requestId);
				if (!card) {
					// The request and terminal streams are independent. Keep a terminal
					// until the request consumer has mounted its card.
					if (!this.pendingTerminalOutcomes.has(outcome.requestId)) this.pendingTerminalOutcomes.set(outcome.requestId, outcome);
					continue;
				}
				this.retireCard(card, outcome);
				this.tui.requestRender();
			}
		} finally {
			if (this.terminalIterator === iterator) this.terminalIterator = undefined;
		}
	}

	private retireCard(card: RequestCard, outcome: RequestOutcome<RequestKind>): void {
		if (card.record.state !== "active" && card.record.state !== "parked") return;
		card.terminal(outcome);
		const removed = this.focusStack.remove(outcome.requestId);
		this.archiveCard(card);
		if (removed) this.restoreFocusAfterStackChange();
	}

	private focusedCard(): RequestCard | undefined {
		const record = this.focusStack.top();
		return record ? this.blockingCards.children.find((child) => child instanceof RequestCard && child.record.id === record.id) as RequestCard | undefined : undefined;
	}

	private visibleCard(): RequestCard | undefined {
		const record = this.focusStack.top() ?? this.focusStack.parkedTop();
		return record ? this.findCard(record.id) : undefined;
	}

	private respondToFocusedCard(): void {
		const card = this.focusedCard();
		const record = card?.record;
		if (!card || !record || !this.options.requestBus) return;
		const actions = requestCardActions(record.request);
		const action = actions[this.focusStack.focusIndex] as RequestCardAction | undefined;
		const response = action ? card.responseFor(action) : undefined;
		if (!response || !this.options.requestBus.respond(response)) return;
		card.resolve(response);
		this.focusStack.pop();
		this.archiveCard(card);
		this.restoreFocusAfterStackChange();
	}

	private findCard(id: string): RequestCard | undefined {
		return this.blockingCards.children.find((child) => child instanceof RequestCard && child.record.id === id) as RequestCard | undefined;
	}

	/** The card leaves the fixed region; a one-line outcome stays in the transcript timeline. */
	private archiveCard(card: RequestCard): void {
		this.blockingCards.removeChild(card);
		this.renderer.addNotice(archivedCardLine(card.record));
	}

	private restoreFocusAfterStackChange(): void {
		const next = this.focusStack.top();
		const nextCard = next ? this.findCard(next.id) : undefined;
		if (nextCard) {
			nextCard.setFocusIndex(this.focusStack.focusIndex);
			this.tui.setFocus(nextCard);
		}
			else this.tui.setFocus(this.composer);
	}

	private async nextWhileRunning<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T> | typeof STOPPED> {
		return Promise.race([iterator.next(), this.stopSignal.then((): typeof STOPPED => STOPPED)]);
	}

	private closeIterator<T>(iterator: AsyncIterator<T> | undefined): void {
		try {
			const close = iterator?.return;
			if (!close) return;
			void Promise.resolve(close.call(iterator)).catch(() => undefined);
		} catch {
			// A best-effort iterator close must not prevent the App from stopping.
		}
	}

	private apply(event: SessionEvent): void {
		this.renderer.apply(event);
		this.tui.requestRender();
	}

	private scrollPageSize(): number {
		return Math.max(1, this.terminal.rows - 2);
	}
}

/** Dynamic hint row whose source is the current focus owner, never a card copy. */
class FocusShortcutsBar implements Component {
	constructor(private readonly focusStack: FocusStack<RequestCardRecord>, private readonly theme: SemanticTheme) {}

	render(width: number): string[] {
		const card = this.focusStack.top() ?? this.focusStack.parkedTop();
		const routes = shortcutRoutes({
			cardFocused: this.focusStack.active,
			cardParked: this.focusStack.hasParked,
			...(card === undefined ? {} : { cardKind: card.request.kind }),
			editorFocused: !this.focusStack.active && !this.focusStack.hasParked,
		});
		const line = renderShortcutHints(routes, Math.max(1, Math.floor(width)), this.theme);
		return line ? [line] : [];
	}

	invalidate(): void {}
}

/** Spinner row shown only while a turn is running. */
class WorkingIndicator implements Component {
	private active = false;

	constructor(private readonly loader: Loader) {}

	start(): void {
		this.active = true;
		this.loader.start();
	}

	stop(): void {
		this.active = false;
		this.loader.stop();
	}

	get isActive(): boolean {
		return this.active;
	}

	render(width: number): string[] {
		return this.active ? this.loader.render(width) : [];
	}

	/** Project the loader's padded component row into one dock segment. */
	statusSegment(width: number): { text: string; styled: string } | undefined {
		if (!this.active) return undefined;
		const line = this.loader.render(width).find((value) => stripAnsi(value).trim().length > 0);
		if (!line) return undefined;
		const styled = line.replace(/^\s+/u, "").replace(/\s+$/u, "");
		const text = stripAnsi(styled).trim();
		return text ? { text, styled } : undefined;
	}

	invalidate(): void {}
}

/** Merges activity and status into the single bottom status row. */
class StatusDock implements Component {
	constructor(private readonly status: StatusLine, private readonly working: WorkingIndicator) {}

	render(width: number): string[] {
		const safeWidth = Math.max(0, Math.floor(width));
		if (safeWidth === 0) return [];
		const statusSegments = this.status.renderSegments();
		const activity = this.working.statusSegment(safeWidth);
		const segments = activity ? [activity, ...statusSegments] : statusSegments;
		return renderStatusDock(safeWidth, segments);
	}

	invalidate(): void {
		this.status.invalidate();
		this.working.invalidate();
	}
}

export interface DockSegment {
	text: string;
	styled: string;
}

/** Pure projection used by StatusDock and deterministic frame tests. */
export function renderStatusDock(width: number, segments: readonly DockSegment[]): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0 || segments.length === 0) return [];
	// The upstream builtin row is a single left-aligned line.  It clips the
	// composed line as a whole, so a short viewport never drops a middle
	// segment merely to preserve a right-most one.
	const line = segments.map((segment) => segment.styled).join(STATUS_SEGMENT_SEPARATOR);
	const fitted = truncateToWidth(line, safeWidth, "…", false);
	return fitted ? [fitted] : [];
}

export function fitDockSegments(segments: readonly DockSegment[], width: number): DockSegment[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return [];
	const result: DockSegment[] = [];
	let used = 0;
	for (const segment of segments) {
		const separatorWidth = result.length === 0 ? 0 : visibleWidth(STATUS_SEGMENT_SEPARATOR);
		const segmentWidth = visibleWidth(segment.text);
		if (used + separatorWidth + segmentWidth > safeWidth) break;
		result.push(segment);
		used += separatorWidth + segmentWidth;
	}
	return result;
}

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "");
}

/** Interactive slot with exactly one visual owner: card or composer. */
class InteractiveSlot implements Component {
	constructor(private readonly editor: Component, private readonly getCard: () => RequestCard | undefined) {}

	render(width: number): string[] {
		return (this.getCard() ?? this.editor).render(width);
	}

	desiredHeight(width: number, maxHeight: number): number {
		const owner = this.getCard() ?? this.editor;
		const heightAware = owner as Component & { desiredHeight?: (width: number, maxHeight: number) => number };
		return heightAware.desiredHeight?.(width, maxHeight) ?? owner.render(width).length;
	}

	renderForHeight(width: number, height: number): string[] {
		const owner = this.getCard() ?? this.editor;
		const heightAware = owner as Component & { renderForHeight?: (width: number, height: number) => string[] };
		// Let the outer slot fitter choose a meaningful window for components that
		// do not expose their own height-aware renderer (notably request cards).
		// Slicing here would discard the card's action tail before it can be pinned.
		return heightAware.renderForHeight?.(width, height) ?? owner.render(width);
	}

	invalidate(): void {
		this.editor.invalidate();
		this.getCard()?.invalidate();
	}
}
