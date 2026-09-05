import { type ContextUsageSnapshot, type InputCompletionItem, type InputCompletionSuggestions, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type SessionEvent } from "@myh/protocol";
import { Host, type HostInput, type HostOutput } from "./host.ts";
import { createFrame, type TerminalFrame } from "./frame.ts";
import { computeScreenLayout, layoutOffsets } from "./layout.ts";
import {
	backspace,
	createEditor,
	editorCursorOffset,
	editorText,
	insertText,
	isEditorEmpty,
	moveDown,
	moveEnd,
	moveHome,
	moveLeft,
	moveRight,
	moveUp,
	replaceEditor,
	submitEditor,
	type EditorState,
} from "./editor.ts";
import { paintComposer, wrapDraft } from "./composer.ts";
import { paintHeader } from "./header.ts";
import { buildStatusSegments, paintStatus } from "./status-line.ts";
import { paintShortcuts, type ShortcutHint } from "./dock.ts";
import { createTheme, type Theme } from "./theme.ts";
import { isCtrlC, type Key } from "./keys.ts";
import { TranscriptProjector } from "./transcript/projector.ts";
import { presentEntry } from "./transcript/present.ts";
import { computeEntryLayout, entryHeight, paintEntry } from "./transcript/entry-shell.ts";
import { ScrollState, type EntrySpan } from "./scroll.ts";
import { FocusStack } from "./focus-stack.ts";
import { nextEscStep, resolveKeyOwner, shortcutRoutes, type InputRouterState } from "./input-router.ts";
import {
	RequestCard,
	archivedCardLine,
	cardDesiredHeight,
	paintRequestCard,
	requestCardActions,
	type RequestCardRecord,
} from "./request-card.ts";
import { paintWelcome } from "./welcome.ts";
import { paintPicker, pickerHeight, type PickerState } from "./picker.ts";

export type AppHostMode = "main" | "alt";

/** Structural view of the core request bus; tui may only import @myh/protocol. */
export interface AppRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: unknown): boolean;
	terminals(): AsyncIterable<RequestOutcome<RequestKind>>;
	close(): void;
	getTerminal?(requestId: string): RequestOutcome<RequestKind> | undefined;
}

/** Structural view of the core agent port; AgentRunner satisfies this. */
export interface AppPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	abort?(): void;
	getUsage?(): ContextUsageSnapshot | undefined;
}

/** Structural view of core's InputCompletionSource; parsing stays in core. */
export interface AppCompletionSource {
	getSuggestions(input: string, cursor: number): InputCompletionSuggestions | null | Promise<InputCompletionSuggestions | null>;
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number };
}

export interface AppOptions {
	port: AppPort;
	/** main is an alias for alt until an inline host is implemented. */
	host: AppHostMode;
	requestBus: AppRequestBus;
	completionSource?: AppCompletionSource | undefined;
	getStatus?: () => { provider: string; model: string };
	cwd: string;
	homeDir: string;
	showWelcome?: boolean;
	/** Test seams; default to process.stdin / process.stdout / process.env. */
	stdin?: HostInput;
	stdout?: HostOutput;
	env?: NodeJS.ProcessEnv;
}

/**
 * Phase 2.2 B4: blocking request cards replace the composer slot. Esc parks
 * (does not answer). Tab/Space resume a parked card. Explicit action is the
 * only path that calls respond().
 */
export class App {
	private readonly host: Host;
	private readonly theme: Theme;
	private readonly draft: EditorState = createEditor();
	private readonly projector = new TranscriptProjector();
	private readonly scroll = new ScrollState();
	private readonly focus = new FocusStack<RequestCardRecord>();
	private readonly cards = new Map<string, RequestCard>();
	private running = false;
	private readonly queued: string[] = [];
	private runTask: Promise<void> | undefined;
	private picker: PickerState | undefined;
	private suggestionVersion = 0;
	private previousTranscript: { spans: EntrySpan[]; totalRows: number; height: number } | undefined;
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
		try {
			this.host.start();
			this.repaint();
			void this.consumeRequests();
			void this.consumeTerminals();
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.started) return this.stoppedPromise;
		this.started = false;
		this.queued.length = 0;
		this.suggestionVersion++;
		try {
			if (this.running) this.options.port.abort?.();
			this.requestBus.close();
			this.host.stop();
			await this.runTask;
		} finally {
			this.resolveStopped?.();
		}
	}

	async waitUntilStopped(): Promise<void> {
		return this.stoppedPromise;
	}

	private routerState(): InputRouterState {
		const top = this.focus.top();
		const parked = this.focus.parkedTop();
		return {
			cardFocused: this.focus.active,
			cardParked: !this.focus.active && this.focus.hasParked,
			cardKind: (top ?? parked)?.request.kind,
			editorFocused: true,
			running: this.running,
		};
	}

	private visibleCard(): RequestCard | undefined {
		const record = this.focus.top() ?? this.focus.parkedTop();
		return record ? this.cards.get(record.id) : undefined;
	}

	private handleKey(key: Key): void {
		if (!this.started) return;
		if (isCtrlC(key)) {
			void this.stop();
			return;
		}
		const owner = resolveKeyOwner(this.routerState());
		if (owner === "card") {
			this.handleCardKey(key);
			return;
		}
		if (owner === "scrollback") {
			this.handleScrollbackKey(key);
			return;
		}
		this.handleComposerKey(key);
	}

	private handleCardKey(key: Key): void {
		const card = this.visibleCard();
		if (card?.handleTextKey(key, this.focus.focusIndex)) {
			this.repaint();
			return;
		}
		if (card && (key.type === "pageUp" || key.type === "pageDown")) {
			card.bodyOffset = Math.max(0, card.bodyOffset + (key.type === "pageDown" ? 3 : -3));
			this.repaint();
			return;
		}
		const result = this.focus.handleKey(key);
		if (result.action === "park" && result.card) {
			this.cards.get(result.card.id)?.park();
			this.repaint();
			return;
		}
		if (result.action === "focus_next" || result.action === "focus_previous") {
			this.repaint();
			return;
		}
		if (key.type === "enter" || (key.type === "char" && key.text === " ")) {
			this.chooseAction(this.focus.focusIndex);
			return;
		}
		if (key.type === "char" && /^[1-9]$/.test(key.text)) {
			this.chooseAction(Number(key.text) - 1);
			return;
		}
	}

	private handleScrollbackKey(key: Key): void {
		const result = this.focus.handleKey(key);
		if (result.action === "resume" && result.card) {
			this.cards.get(result.card.id)?.resume();
			this.repaint();
			return;
		}
		if (key.type === "escape") return; // parked: Esc must not abort (AC-34)
		if (key.type === "pageUp") this.scrollPage(1);
		else if (key.type === "pageDown") this.scrollPage(-1);
		else if (key.type === "ctrl" && key.key === "o") this.toggleLatestFoldable();
		this.repaint();
	}

	private handleComposerKey(key: Key): void {
		if (this.picker && this.handlePickerKey(key)) return;
		if (key.type === "ctrlEnter") {
			this.cancelAndSend();
			return;
		}
		if (key.type === "escape") {
			if (nextEscStep(this.routerState()) === "abort_turn") this.options.port.abort?.();
			this.repaint();
			return;
		}
		if (key.type === "ctrl" && key.key === "o") {
			this.toggleLatestFoldable();
			this.repaint();
			return;
		}
		switch (key.type) {
			case "char":
				insertText(this.draft, key.text);
				break;
			case "paste":
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
			case "pageUp":
				this.scrollPage(1);
				break;
			case "pageDown":
				this.scrollPage(-1);
				break;
			default:
				return;
		}
		this.refreshSuggestions();
		this.repaint();
	}

	private handlePickerKey(key: Key): boolean {
		const picker = this.picker;
		if (!picker) return false;
		if (key.type === "escape") {
			this.picker = undefined;
			this.suggestionVersion++;
			this.repaint();
			return true;
		}
		if (key.type === "tab" || (key.type === "arrow" && key.direction === "down")) {
			picker.index = (picker.index + 1) % picker.items.length;
			this.repaint();
			return true;
		}
		if (key.type === "shiftTab" || (key.type === "arrow" && key.direction === "up")) {
			picker.index = (picker.index - 1 + picker.items.length) % picker.items.length;
			this.repaint();
			return true;
		}
		if (key.type === "enter") {
			this.applyPicker();
			return true;
		}
		return false;
	}

	private applyPicker(): void {
		const picker = this.picker;
		const source = this.options.completionSource;
		const item = picker?.items[picker.index];
		if (!picker || !source || !item) return;
		const applied = source.applyCompletion(editorText(this.draft), editorCursorOffset(this.draft), item, picker.prefix);
		replaceEditor(this.draft, applied.input, applied.cursor);
		this.picker = undefined;
		this.refreshSuggestions();
		this.repaint();
	}

	private refreshSuggestions(): void {
		const version = ++this.suggestionVersion;
		const source = this.options.completionSource;
		if (!source) {
			this.picker = undefined;
			return;
		}
		const input = editorText(this.draft);
		const cursor = editorCursorOffset(this.draft);
		this.picker = undefined;
		void Promise.resolve().then(() => source.getSuggestions(input, cursor)).then((result) => {
			if (!this.started || version !== this.suggestionVersion) return;
			this.picker = result && result.items.length > 0 ? { items: result.items, prefix: result.prefix, index: 0 } : undefined;
			this.repaint();
		}).catch(() => {
			if (version === this.suggestionVersion) this.picker = undefined;
		});
	}

	private chooseAction(index: number): void {
		const record = this.focus.top();
		const card = record ? this.cards.get(record.id) : undefined;
		if (!card) return;
		const action = requestCardActions(card.record.request)[index];
		if (!action) return;
		const envelope = card.responseFor(action);
		if (!envelope) {
			this.repaint();
			return;
		}
		if (!this.requestBus.respond(envelope)) return;
		card.markResolved(envelope.result);
		this.focus.remove(card.record.id);
		this.cards.delete(card.record.id);
		this.projector.addNotice(archivedCardLine(card.record));
		this.repaint();
	}

	private submit(): void {
		if (isEditorEmpty(this.draft)) {
			this.repaint();
			return;
		}
		const input = submitEditor(this.draft);
		this.suggestionVersion++;
		this.picker = undefined;
		if (this.dispatchCommand(input)) {
			this.repaint();
			return;
		}
		if (this.running) {
			this.queued.push(input);
			this.repaint();
			return;
		}
		this.runTask = this.runTurn(input);
		this.repaint();
	}

	private cancelAndSend(): void {
		if (isEditorEmpty(this.draft) && !this.running) return;
		const input = isEditorEmpty(this.draft) ? undefined : submitEditor(this.draft);
		this.suggestionVersion++;
		this.picker = undefined;
		if (this.running) {
			this.queued.splice(0, this.queued.length, ...(input ? [input] : []));
			this.options.port.abort?.();
			this.repaint();
			return;
		}
		if (input) {
			if (this.dispatchCommand(input)) this.repaint();
			else this.runTask = this.runTurn(input);
		}
	}

	private dispatchCommand(input: string): boolean {
		const command = input.trim();
		if (command === "/quit" || command === "/exit") {
			void this.stop();
			return true;
		}
		if (command === "/clear") {
			this.projector.clear();
			this.scroll.jumpToEnd();
			this.previousTranscript = undefined;
			return true;
		}
		if (command === "/help") {
			this.projector.addNotice("/help · /clear · /quit · @file to mention");
			return true;
		}
		return false;
	}

	private async runTurn(input: string): Promise<void> {
		this.running = true;
		try {
			let current: string | undefined = input;
			while (current !== undefined && this.started) {
				this.repaint();
				try {
					for await (const event of this.options.port.runTurn(current)) this.handleEvent(event);
				} catch (error) {
					this.projector.addNotice(error instanceof Error ? error.message : String(error));
				}
				current = this.queued.shift();
				if (current !== undefined && this.dispatchCommand(current)) current = this.queued.shift();
			}
		} finally {
			this.running = false;
			this.repaint();
		}
	}

	private handleEvent(event: SessionEvent): void {
		this.projector.apply(event);
		if (event.type === "message_end" && event.message.errorMessage) this.projector.addNotice(event.message.errorMessage);
		if (event.type === "turn_end" && (event.stopReason === "error" || event.stopReason === "aborted")) this.projector.addNotice(`turn ${event.stopReason}`);
		this.repaint();
	}

	private toggleLatestFoldable(): void {
		const foldable = this.projector.getEntries().filter((entry) => entry.kind === "thinking" || entry.kind === "execute" || entry.kind === "edit");
		const last = foldable.at(-1);
		if (!last) return;
		const current = last.block.currentDisplayMode ?? last.block.defaultDisplayMode ?? last.block.fold.defaultDisplayMode ?? "expanded";
		const next = current === "collapsed" ? "expanded" : "collapsed";
		this.projector.setEntryDisplayState(last.id, next, true);
	}

	private scrollPage(direction: 1 | -1): void {
		const { totalRows, viewportHeight } = this.transcriptMetrics();
		this.scroll.pageBy(direction, viewportHeight, Math.max(0, totalRows - viewportHeight));
	}

	private transcriptMetrics(): { totalRows: number; viewportHeight: number; spans: EntrySpan[] } {
		const columns = this.host.columns;
		const rows = this.host.rows;
		const segments = this.statusSegments();
		const plan = this.layoutPlan(columns, rows, segments.length > 0);
		const presentations = this.presentations(columns);
		let start = 0;
		const spans: EntrySpan[] = presentations.map((presentation) => {
			const height = entryHeight(presentation.presentation);
			const span = { entryId: presentation.id, start, height };
			start += height;
			return span;
		});
		return { totalRows: start, viewportHeight: plan.transcript.height, spans };
	}

	private presentations(columns: number) {
		return this.projector.getEntries().map((entry) => {
			const hasTimestamp = entry.kind === "user" || entry.kind === "assistant";
			const layout = computeEntryLayout(columns, hasTimestamp ? "0:00 PM" : undefined);
			return { id: entry.id, presentation: presentEntry(entry, layout.contentWidth, this.theme) };
		});
	}

	private statusSegments(): string[] {
		const status = this.options.getStatus?.();
		const usage = this.options.port.getUsage?.();
		const cost = usage?.costUsd;
		const contextLabel = this.contextLabel(usage);
		return buildStatusSegments({
			...(status ?? {}),
			...(contextLabel ? { contextLabel } : {}),
			...(cost !== undefined ? { cost } : {}),
			...(this.running ? { activity: this.queued.length > 0 ? `queued (${this.queued.length})` : "working" } : {}),
		});
	}

	private contextLabel(usage: ContextUsageSnapshot | undefined): string | undefined {
		if (usage?.contextTokens === undefined) return undefined;
		return `${usage.contextEstimated ? "~" : ""}${formatTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ""}`;
	}

	private layoutPlan(columns: number, rows: number, hasStatus: boolean) {
		const card = this.visibleCard();
		const interactiveOwner = card ? ("card" as const) : ("composer" as const);
		const interactiveLines = card
			? cardDesiredHeight(card.record.request, columns, this.theme)
			: Math.max(1, wrapDraft(this.draft, Math.max(1, columns - 6)).lines.length);
		return computeScreenLayout({ columns, rows, interactiveLines, hasStatus, interactiveOwner });
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
		const plan = this.layoutPlan(columns, rows, segments.length > 0);
		const offsets = layoutOffsets(plan);
		if (plan.header.height === 1) {
			paintHeader(frame, offsets.header, { cwd: this.options.cwd, homeDir: this.options.homeDir }, this.theme);
		}
		const entries = this.projector.getEntries();
		if ((this.options.showWelcome ?? false) && entries.length === 0 && plan.transcript.height > 0 && !this.picker) {
			paintWelcome(frame, offsets.transcript, plan.transcript.height, { cwd: this.options.cwd, homeDir: this.options.homeDir, model: this.options.getStatus?.().model }, this.theme);
		} else {
			this.paintTranscriptRegion(frame, offsets.transcript, plan.transcript.height);
		}
		if (this.picker && plan.interactive.owner === "composer") {
			const height = pickerHeight(this.picker.items.length, Math.min(8, plan.transcript.height));
			paintPicker(frame, offsets.transcript + plan.transcript.height - height, height, this.picker, this.theme);
		}
		const card = this.visibleCard();
		if (plan.interactive.owner === "card" && card) {
			paintRequestCard({
				frame,
				y: offsets.interactive,
				height: plan.interactive.height,
				card,
				focusIndex: this.focus.active ? this.focus.focusIndex : 0,
				focused: this.focus.active,
				theme: this.theme,
			});
		} else {
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
		}
		if (plan.status.height === 1) paintStatus(frame, offsets.status, segments, this.theme);
		if (plan.shortcuts.height === 1) {
			const routes = shortcutRoutes(this.routerState());
			const hints: ShortcutHint[] = routes.map((route) => ({ keys: route.keys, label: route.label, ...(route.pinned ? { pinned: true } : {}) }));
			paintShortcuts(frame, offsets.shortcuts, hints, this.theme);
		}
		return frame;
	}

	private paintTranscriptRegion(frame: TerminalFrame, top: number, height: number): void {
		if (height <= 0) return;
		const presentations = this.presentations(frame.columns);
		let start = 0;
		const spans: EntrySpan[] = presentations.map((presentation) => {
			const span = { entryId: presentation.id, start, height: entryHeight(presentation.presentation) };
			start += span.height;
			return span;
		});
		const totalRows = start;
		if (this.previousTranscript) this.scroll.captureAnchor(this.previousTranscript.spans, this.previousTranscript.totalRows, this.previousTranscript.height);
		this.scroll.restoreAnchor(spans, totalRows, height);
		this.previousTranscript = { spans, totalRows, height };
		const maxOffset = Math.max(0, totalRows - height);
		if (this.scroll.offset > maxOffset) this.scroll.scrollBy(0, maxOffset);
		const windowTop = Math.max(0, totalRows - height - Math.min(this.scroll.offset, maxOffset));
		for (const [index, span] of spans.entries()) {
			if (span.start + span.height <= windowTop || span.start >= windowTop + height) continue;
			paintEntry(frame, top + (span.start - windowTop), presentations[index]!.presentation, this.theme, { top, bottom: top + height });
		}
	}

	private async consumeRequests(): Promise<void> {
		try {
			for await (const envelope of this.requestBus.requests()) {
				if (!this.started) return;
				const card = new RequestCard(envelope);
				const terminal = this.requestBus.getTerminal?.(envelope.id);
				if (terminal) {
					card.terminal(terminal);
					this.projector.addNotice(archivedCardLine(card.record));
					this.repaint();
					continue;
				}
				this.cards.set(envelope.id, card);
				this.focus.push(card.record);
				this.repaint();
			}
		} catch {
			await this.stop();
		}
	}

	private async consumeTerminals(): Promise<void> {
		try {
			for await (const outcome of this.requestBus.terminals()) {
				if (!this.started) return;
				const card = this.cards.get(outcome.requestId);
				if (!card) continue;
				if (card.record.state === "resolved") continue;
				card.terminal(outcome);
				this.focus.remove(outcome.requestId);
				this.cards.delete(outcome.requestId);
				this.projector.addNotice(archivedCardLine(card.record));
				this.repaint();
			}
		} catch {
			await this.stop();
		}
	}

	private get requestBus(): AppRequestBus {
		return this.options.requestBus;
	}
}

/** Compact token totals for the header (13K / 1.0M style). */
export function formatTokens(total: number): string {
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
	if (total >= 1_000) return `${Math.round(total / 1_000)}K`;
	return String(total);
}
