import type { RequestEnvelopeUnion, ResponseEnvelope, SessionEvent } from "@myh/protocol";
import { Key, VStack, Container, matchesKey, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { EscController } from "./esc.ts";
import { createEditor } from "./editor.ts";
import { FocusStack } from "./focus-stack.ts";
import { createTuiHost, type TuiHostMode } from "./host.ts";
import { TranscriptScrollView } from "./scroll.ts";
import { StreamRenderer } from "./stream-renderer.ts";
import { RequestCard, requestCardActions, type RequestCardAction } from "./request-card.ts";

export interface AppOptions {
	port: TuiAgentPort;
	terminal?: Terminal;
	host?: TuiHostMode;
	onRewind?: () => void;
	requestBus?: TuiRequestBus;
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
}

export class App {
	readonly terminal: Terminal;
	readonly tui: TUI;
	readonly renderer: StreamRenderer;
	readonly transcript: TranscriptScrollView;
	readonly editor: ReturnType<typeof createEditor>;
	readonly focusStack = new FocusStack();
	private runningTask: Promise<void> | undefined;
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
		this.terminal = options.terminal ?? createTuiHost(options.host ? { mode: options.host } : {}).terminal;
		this.tui = createTuiHost({ terminal: this.terminal, ...(options.host ? { mode: options.host } : {}) });
		this.renderer = new StreamRenderer();
		this.transcript = new TranscriptScrollView(this.renderer);
		this.editor = createEditor(this.tui, (text) => void this.submit(text));
		const layout = new VStack([
			{ component: this.transcript, grow: 1, minSize: 1 },
			{ component: this.blockingCards, basis: "auto", shrink: 0 },
			{ component: this.editor, basis: "auto", shrink: 0 },
		]);
		if ("setLayoutRoot" in this.tui && typeof this.tui.setLayoutRoot === "function") this.tui.setLayoutRoot(layout);
		else this.tui.addChild(layout);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => {
			if (this.focusStack.active) {
				const focusResult = this.focusStack.handleInput(data);
				if (matchesKey(data, Key.enter)) {
					this.respondToFocusedCard();
				} else if (focusResult.action === "pop") {
					focusResult.card && this.findCard(focusResult.card.id)?.dismiss();
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
					if (card) this.findCard(card.id)?.dismiss();
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
