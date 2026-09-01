import type { ContextUsageSnapshot, RequestEnvelopeUnion, ResponseEnvelope, SessionEvent } from "@myh/protocol";
import { Key, VStack, Container, ProcessTerminal, matchesKey, type AutocompleteProvider, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { EscController } from "./esc.ts";
import { createEditor } from "./editor.ts";
import { FocusStack } from "./focus-stack.ts";
import { createTuiHost, type TuiHostMode } from "./host.ts";
import { TranscriptScrollView } from "./scroll.ts";
import { StreamRenderer } from "./stream-renderer.ts";
import { RequestCard, requestCardActions, responseForRequestDismiss, type RequestCardAction } from "./request-card.ts";
import { createInputAutocompleteProvider, type TuiInputCompletionSource } from "./input/autocomplete.ts";
import { StatusLine, type StatusLineState } from "./status-line.ts";
import type { SemanticTheme } from "./theme.ts";

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
}

export interface TuiRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: ResponseEnvelope): boolean;
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
	readonly statusLine: StatusLine;
	readonly focusStack = new FocusStack();
	private runningTask: Promise<void> | undefined;
	private turnCount = 0;
	private stopped = false;
	private readonly stoppedPromise: Promise<void>;
	private resolveStopped!: () => void;
	private readonly esc = new EscController();
	private readonly blockingCards = new Container();
	private requestTask?: Promise<void>;

	constructor(private readonly options: AppOptions) {
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.tui = createTuiHost({ terminal: this.terminal, ...(options.host ? { mode: options.host } : {}) });
		this.renderer = new StreamRenderer();
		this.transcript = new TranscriptScrollView(this.renderer);
		this.statusLine = options.statusLine ?? new StatusLine({
			...(options.theme ? { theme: options.theme } : {}),
			getState: () => {
				// Usage from the port is the authoritative context truth point; an
				// optional status provider may add identity or other non-usage fields.
				const provided = {
					...(options.getStatus?.() ?? {}),
					...(options.port.getUsage?.() ?? {}),
				} as StatusLineState;
				return {
					...provided,
					running: provided.running ?? (this.runningTask ? 1 : 0),
					turn: provided.turn ?? this.turnCount,
				};
			},
		});
		const autocompleteProvider = options.autocompleteProvider ?? (options.completionSource ? createInputAutocompleteProvider(options.completionSource) : undefined);
		this.editor = createEditor(this.tui, (text) => void this.submit(text), autocompleteProvider ? { autocompleteProvider } : {});
		const layout = new VStack([
			{ component: this.transcript, grow: 1, minSize: 1 },
			{ component: this.blockingCards, basis: "auto", shrink: 0 },
			{ component: this.statusLine, basis: "auto", shrink: 0 },
			{ component: this.editor, basis: "auto", shrink: 0 },
		]);
		if ("setLayoutRoot" in this.tui && typeof this.tui.setLayoutRoot === "function") this.tui.setLayoutRoot(layout);
		else this.tui.addChild(layout);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => {
			if (this.focusStack.active) {
				if (matchesKey(data, Key.enter)) {
					this.respondToFocusedCard();
				} else {
					const focusResult = this.focusStack.handleInput(data);
					if (focusResult.action !== "pop") {
						this.tui.requestRender();
						return { consume: true };
					}
					if (focusResult.card) this.dismissCard(focusResult.card.id);
					this.restoreFocusAfterStackChange();
				}
				this.tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, Key.ctrl("enter"))) {
				void this.cancelAndSend();
				return { consume: true };
			}
			if (data === "\u001b") {
				const action = this.esc.press({ hasFocusedCard: this.focusStack.active, running: this.runningTask !== undefined });
				if (action === "pop") {
					const card = this.focusStack.pop();
					if (card) this.dismissCard(card.id);
					this.restoreFocusAfterStackChange();
				}
				else if (action === "abort") this.options.port.abort();
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
		if (this.options.requestBus) this.requestTask = this.consumeRequests(this.options.requestBus);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.tui.stop();
		this.options.requestBus?.close?.();
		this.resolveStopped();
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
		try {
			await task;
		} finally {
			if (this.runningTask === task) this.runningTask = undefined;
		}
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
		for await (const request of requestBus.requests()) {
			if (this.stopped) return;
			const card = new RequestCard(request);
			this.blockingCards.addChild(card);
			this.focusStack.push(card.record);
			this.tui.setFocus(card);
			this.tui.requestRender();
		}
	}

	private focusedCard(): RequestCard | undefined {
		const record = this.focusStack.top();
		return record ? this.blockingCards.children.find((child) => child instanceof RequestCard && child.record.id === record.id) as RequestCard | undefined : undefined;
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
		this.restoreFocusAfterStackChange();
	}

	private findCard(id: string): RequestCard | undefined {
		return this.blockingCards.children.find((child) => child instanceof RequestCard && child.record.id === id) as RequestCard | undefined;
	}

	private dismissCard(id: string): void {
		const card = this.findCard(id);
		if (!card || card.record.state !== "active") return;
		const cancellation = responseForRequestDismiss(card.record.request);
		const accepted = this.options.requestBus?.respond(cancellation) ?? false;
		card.dismiss(accepted ? cancellation : undefined);
	}

	private restoreFocusAfterStackChange(): void {
		const next = this.focusStack.top();
		if (next) this.tui.setFocus(this.findCard(next.id) ?? this.editor);
		else this.tui.setFocus(this.editor);
	}

	private apply(event: SessionEvent): void {
		this.renderer.apply(event);
		this.tui.requestRender();
	}
}
