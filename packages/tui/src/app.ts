import { type ContextUsageSnapshot, type InputCompletionItem, type InputCompletionSuggestions, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type SessionEvent, type SessionMessage } from "@forge-agent/protocol";
import { Host, type HostInput, type HostOutput } from "./host.ts";
import { createFrame, defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import { wrapText } from "./width.ts";
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
import type { TranscriptEntry } from "./transcript/types.ts";
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
import { paintWelcome, welcomeHeight } from "./welcome.ts";
import { paintPicker, pickerHeight, type PickerState } from "./picker.ts";
import { DetailView } from "./detail-view.ts";
import { entryDetail } from "./transcript/detail.ts";
import { transcriptViews } from "./transcript/groups.ts";
import { TextSelection } from "./text-selection.ts";
import { SessionMenu, type AppSessionPreview, type AppSessionSummary } from "./session-menu.ts";

export type AppHostMode = "main" | "alt";

/** Structural view of the core request bus; tui may only import @forge-agent/protocol. */
export interface AppRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: unknown): boolean;
	terminals(): AsyncIterable<RequestOutcome<RequestKind>>;
	close(): void;
	getTerminal?(requestId: string): RequestOutcome<RequestKind> | undefined;
}

/** Structural view of the core agent port; the Forge SDK agent satisfies this. */
export interface AppPort {
	compact?(instructions?: string, emit?: (event: SessionEvent) => void): Promise<unknown>;
	runTurn(input: string): AsyncIterable<SessionEvent>;
	abort?(): void;
	getUsage?(): ContextUsageSnapshot | undefined;
}

/** Structural view of core's InputCompletionSource; parsing stays in core. */
export interface AppCompletionSource {
	getSuggestions(input: string, cursor: number): InputCompletionSuggestions | null | Promise<InputCompletionSuggestions | null>;
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number };
}

export interface AppSession {
	id: string;
	port: AppPort;
	requestBus: AppRequestBus;
	history: readonly SessionMessage[];
	hasHistory(): boolean;
}
export interface AppSessionHost {
	readonly current: AppSession;
	list(): Promise<{ sessions: AppSessionSummary[]; diagnostics: string[] }>;
	preview?(id: string, cached?: AppSessionPreview): Promise<AppSessionPreview>;
	switchTo(id?: string, beforeRelease?: () => Promise<void>): Promise<AppSession>;
	dispose(): Promise<void>;
}

export interface AppOptions {
	sessions?: AppSessionHost;
	port: AppPort;
	/** main is an alias for alt until an inline host is implemented. */
	host: AppHostMode;
	requestBus: AppRequestBus;
	completionSource?: AppCompletionSource | undefined;
	getStatus?: () => { provider: string; model: string };
	cwd: string;
	homeDir: string;
	showWelcome?: boolean;
	history?: readonly SessionMessage[];
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
	private focus = new FocusStack<RequestCardRecord>();
	private readonly cards = new Map<string, RequestCard>();
	private session: AppSession | undefined;
	private sessionMenu: SessionMenu | undefined;
	private menuLoading = false;
	private menuVersion = 0;
	private pendingTarget: string | undefined;
	private switchTask: Promise<void> | undefined;
	private switching = false;
	private readonly savedDrafts = new Map<string, string>();
	private executionError: unknown;
	private generation = 0;
	private running = false;
	private compactTask: Promise<void> | undefined;
	private browsing = false;
	private selectedId: string | undefined;
	private viewer: DetailView | undefined;
	private lastClick: { id: string; at: number } | undefined;
	private readonly expandedGroups = new Set<string>();
	private submitted = false;
	private selection: TextSelection | undefined;
	private selectionFlash: TextSelection | undefined;
	private feedback: string | undefined;
	private feedbackTimer: ReturnType<typeof setTimeout> | undefined;
	private copyVersion = 0;
	private interactiveRegion: { x: number; y: number; width: number; height: number } | undefined;
	private readonly queued: string[] = [];
	private autoSendPaused = false;
	private replacement: string | undefined;
	private runTask: Promise<void> | undefined;
	private picker: PickerState | undefined;
	private suggestionVersion = 0;
	private previousTranscript: { spans: EntrySpan[]; totalRows: number; height: number } | undefined;
	private started = false;
	private stoppedPromise: Promise<void> | undefined;
	private resolveStopped: (() => void) | undefined;

	constructor(private readonly options: AppOptions) {
		this.session = options.sessions?.current;
		for (const message of this.session?.history ?? options.history ?? []) this.projector.apply({ type: "message_end", message, timestamp: message.timestamp });
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
		clearTimeout(this.feedbackTimer);
		this.pauseSending();
		this.suggestionVersion++;
		this.menuVersion++;
		try {
			if (this.running || this.compactTask) this.port.abort?.();
			this.requestBus.close();
			this.host.stop();
			await this.runTask;
			await this.compactTask;
			await this.options.sessions?.dispose();
			await this.switchTask;
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
		const selected = this.selectedId ? this.projector.getEntry(this.selectedId) : undefined;
		const group = this.selectedId?.startsWith("group:") ?? false;
		return {
			cardFocused: this.focus.active,
			cardParked: !this.focus.active && this.focus.hasParked,
			cardKind: (top ?? parked)?.request.kind,
			cardSubInput: this.focus.active && !!top && requestCardActions(top.request)[this.focus.focusIndex] === "answer_text",
			editorFocused: !this.browsing,
			running: this.running || this.compactTask !== undefined,
			selectedCanView: group || !!selected,
			selectedCanFold: group || !!selected && ["tool", "thinking", "execute", "edit"].includes(selected.kind),
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
		if (this.switching) return;
		if (this.sessionMenu) {
			const action = this.sessionMenu.handleKey(key);
			if (action?.type === "cancel") { this.menuVersion++; this.menuLoading = false; this.sessionMenu = undefined; this.pendingTarget = undefined; }
			if (action?.type === "select") { this.menuVersion++; this.sessionMenu = undefined; this.requestSwitch(action.id); }
			if (action?.type === "preview") void this.loadSessionPreview(this.sessionMenu!, action.id, action.revision);
			if (action?.type === "discard") { this.sessionMenu = undefined; this.beginSwitch(this.pendingTarget); }
			this.repaint();
			return;
		}
		if (key.type === "mouse") { this.handleMouse(key); return; }
		if (this.viewer) {
			const action = this.viewer.handleKey(key);
			if (action?.type === "close") this.viewer = undefined;
			if (action?.type === "copy") this.copyText(action.text);
			this.repaint();
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
		if (key.type === "escape" && this.routerState().cardSubInput) {
			this.focus.handleKey({ type: "tab" });
			this.repaint();
			return;
		}
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
			this.browsing = true;
			this.selectedId ??= this.presentations(this.screen().columns).at(-1)?.id;
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
		const result = this.focus.handleKey(key.type === "char" && key.text === "i" ? { type: "tab" } : key);
		if (result.action === "resume" && result.card) {
			this.cards.get(result.card.id)?.resume();
			this.repaint();
			return;
		}
		if (key.type === "tab" || (key.type === "char" && ["i", " "].includes(key.text))) {
			this.browsing = false;
			this.repaint();
			return;
		}
		if (key.type === "escape") {
			if (nextEscStep(this.routerState()) === "abort_turn") { this.pauseSending(); this.port.abort?.(); }
			this.repaint();
			return;
		}
		if (key.type === "pageUp") this.scrollPage(1);
		else if (key.type === "pageDown") this.scrollPage(-1);
		else if (key.type === "enter" || (key.type === "ctrl" && key.key === "f")) this.openDetail();
		else if (key.type === "arrow") {
			if (key.direction === "up" || key.direction === "down") this.selectEntry(key.direction === "up" ? -1 : 1);
			else this.foldSelected(key.direction === "left" ? "collapsed" : "expanded");
		} else if (key.type === "char") {
			if (key.text === "j" || key.text === "k") this.selectEntry(key.text === "k" ? -1 : 1);
			else if (key.text === "e") this.foldSelected();
			else if (key.text === "h" || key.text === "l") this.foldSelected(key.text === "h" ? "collapsed" : "expanded");
			else if (key.text === "G") this.scroll.jumpToEnd();
			else if (key.text === "y" || key.text === "Y") {
				const entry = this.selectedId ? this.projector.getEntry(this.selectedId) : undefined;
				if (entry) { const detail = entryDetail(entry); this.copyText(key.text === "Y" ? detail.metadata : detail.lines.join("\n")); }
			}
		}
		this.repaint();
	}

	private handleComposerKey(key: Key): void {
		if (this.picker && this.handlePickerKey(key)) return;
		if (key.type === "tab") {
			this.browsing = true;
			this.selectedId ??= this.presentations(this.screen().columns).at(-1)?.id;
			this.suggestionVersion++;
			this.repaint();
			return;
		}
		if (key.type === "ctrlEnter") {
			this.cancelAndSend();
			return;
		}
		if (key.type === "escape") {
			if (nextEscStep(this.routerState()) === "abort_turn") {
				this.pauseSending();
				this.port.abort?.();
			}
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
			case "newline":
				insertText(this.draft, "\n");
				break;
			case "delete": {
				const before = editorCursorOffset(this.draft);
				moveRight(this.draft);
				if (editorCursorOffset(this.draft) !== before) backspace(this.draft);
				break;
			}
			case "enter":
				this.submit();
				return;
			case "backspace":
				backspace(this.draft);
				break;
			case "arrow":
				if (key.direction === "left") moveLeft(this.draft);
				else if (key.direction === "right") moveRight(this.draft);
				else if (key.direction === "up") {
					const recalled = isEditorEmpty(this.draft) ? this.queued.pop() : undefined;
					if (recalled !== undefined) replaceEditor(this.draft, recalled, recalled.length);
					else moveUp(this.draft);
				}
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
		let input = submitEditor(this.draft);
		const [firstLine, ...rest] = input.split("\n");
		if (["/new", "/resume"].includes(firstLine!.trim()) && rest.length) {
			input = firstLine!.trim();
			const remaining = rest.join("\n");
			replaceEditor(this.draft, remaining, remaining.length);
		}
		this.suggestionVersion++;
		this.picker = undefined;
		if (this.dispatchCommand(input)) {
			this.repaint();
			return;
		}
		if (this.running || this.compactTask) {
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
		if (input && this.dispatchCommand(input)) { this.repaint(); return; }
		if (this.running) {
			this.autoSendPaused = true;
			if (this.replacement !== undefined) this.queued.push(this.replacement);
			this.replacement = input;
			this.port.abort?.();
			this.repaint();
			return;
		}
		if (input) {
			if (this.dispatchCommand(input)) this.repaint();
			else this.runTask = this.runTurn(input);
		}
	}

	private restoreInputs(inputs: string[]): void {
		if (inputs.length === 0) return;
		if (!isEditorEmpty(this.draft)) inputs.push(editorText(this.draft));
		const text = inputs.join("\n\n");
		replaceEditor(this.draft, text, text.length);
		this.suggestionVersion++;
		this.picker = undefined;
	}

	private pauseSending(): void {
		this.autoSendPaused = true;
		if (this.replacement !== undefined) this.queued.push(this.replacement);
		this.replacement = undefined;
		this.restoreInputs(this.queued.splice(0));
	}

	private dispatchCommand(input: string): boolean {
		const command = input.trim();
		if (command === "/new") { this.requestSwitch(); return true; }
		if (command === "/resume") { void this.openSessions(); return true; }
		if (command === "/compact" || command.startsWith("/compact ")) {
			if (this.compactTask) return true;
			if (!this.port.compact) { this.projector.addNotice("Compaction unavailable"); return true; }
			this.pauseSending();
			this.port.abort?.();
			this.compactTask = this.port.compact(command.slice(8).trim() || undefined, (event) => this.handleEvent(event))
				.then(() => {}, (error: unknown) => { this.executionError = error; this.projector.addNotice(error instanceof Error ? error.message : String(error)); })
				.finally(() => { this.compactTask = undefined; this.pauseSending(); this.repaint(); });
			return true;
		}
		if (command === "/quit" || command === "/exit") {
			void this.stop();
			return true;
		}
		if (command === "/clear") {
			this.projector.clear();
			this.selectedId = undefined;
			this.expandedGroups.clear();
			this.scroll.jumpToEnd();
			this.previousTranscript = undefined;
			this.projector.addNotice("已清屏，上下文仍保留");
			return true;
		}
		if (command === "/help") {
			this.projector.addNotice("/help · /clear · /new · /resume · /compact · /quit · @file to mention");
			return true;
		}
		return false;
	}

	private async openSessions(): Promise<void> {
		const sessions = this.options.sessions;
		if (!sessions) { this.projector.addNotice("Session switching unavailable"); return; }
		const version = ++this.menuVersion;
		this.menuLoading = true;
		const menu = new SessionMenu("list", [], [], this.session?.id, true);
		this.sessionMenu = menu;
		this.repaint();
		try {
			const result = await sessions.list();
			if (this.started && version === this.menuVersion) menu.setList(result.sessions, result.diagnostics);
		} catch (error) { if (this.started && version === this.menuVersion) menu.setList([], [String(error)]); }
		finally { if (version === this.menuVersion) this.menuLoading = false; this.repaint(); }
	}

	private async loadSessionPreview(menu: SessionMenu, id: string, revision: number): Promise<void> {
		try {
			const preview = await this.options.sessions?.preview?.(id, menu.cachedPreview(id));
			if (this.started && this.sessionMenu === menu) menu.setPreview(id, revision, preview, preview ? undefined : "当前宿主不支持预览");
		} catch (error) { if (this.started && this.sessionMenu === menu) menu.setPreview(id, revision, undefined, error instanceof Error ? error.message : String(error)); }
		if (this.started && this.sessionMenu === menu) this.repaint();
	}

	private requestSwitch(id?: string): void {
		if (!this.options.sessions || !this.session) { this.projector.addNotice("Session switching unavailable"); return; }
		if (id === this.session.id || this.switching) return;
		if (!this.session.hasHistory() && (!isEditorEmpty(this.draft) || this.queued.length || this.replacement)) {
			this.pendingTarget = id;
			this.sessionMenu = new SessionMenu("discard");
			return;
		}
		this.beginSwitch(id);
	}

	private beginSwitch(id?: string): void {
		const sessions = this.options.sessions;
		const old = this.session;
		if (!sessions || !old || this.switching) return;
		this.switching = true;
		this.suggestionVersion++;
		this.picker = undefined;
		this.switchTask = (async () => {
			try {
				const next = await sessions.switchTo(id, async () => {
					this.projector.addNotice("正在结束当前任务…");
					this.pauseSending();
					this.port.abort?.();
					this.repaint();
					await this.runTask;
					await this.compactTask;
					if (this.executionError !== undefined) throw this.executionError;
				});
				if (!this.started) return;
				if (old.hasHistory()) this.savedDrafts.set(old.id, editorText(this.draft));
				this.generation++;
				this.session = next;
				this.focus = new FocusStack<RequestCardRecord>();
				this.cards.clear();
				this.projector.clear();
				for (const message of next.history) this.projector.apply({ type: "message_end", message, timestamp: message.timestamp });
				this.selectedId = undefined; this.viewer = undefined; this.browsing = false;
				this.expandedGroups.clear(); this.scroll.jumpToEnd(); this.previousTranscript = undefined;
				this.selection = undefined; this.selectionFlash = undefined; this.lastClick = undefined;
				this.feedback = undefined; this.copyVersion++; clearTimeout(this.feedbackTimer);
				this.queued.length = 0; this.replacement = undefined; this.autoSendPaused = true;
				const draft = this.savedDrafts.get(next.id) ?? "";
				this.savedDrafts.delete(next.id);
				replaceEditor(this.draft, draft, draft.length);
				this.submitted = next.hasHistory();
				void this.consumeRequests(); void this.consumeTerminals();
			} catch (error) { if (this.started) this.projector.addNotice(`会话切换失败：${error instanceof Error ? error.message : String(error)}`); }
			finally { this.switching = false; this.switchTask = undefined; this.pendingTarget = undefined; this.repaint(); }
		})();
	}

	private async runTurn(input: string): Promise<void> {
		this.executionError = undefined;
		this.submitted = true;
		this.running = true;
		this.autoSendPaused = false;
		try {
			let current: string | undefined = input;
			while (current !== undefined && this.started) {
				this.repaint();
				let inputProcessed = false;
				let finalReason: string | undefined;
				try {
					for await (const event of this.port.runTurn(current)) {
						if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") inputProcessed = true;
						const reason = event.type === "turn_end" ? event.stopReason : event.type === "message_end" ? event.message.stopReason : undefined;
						if (reason) finalReason = reason;
						if (event.type === "agent_end" && event.outcome) finalReason = event.outcome;
						this.handleEvent(event);
					}
					if (finalReason === "error" || (finalReason === "aborted" && !this.autoSendPaused)) this.pauseSending();
				} catch (error) {
					this.executionError = error;
					this.projector.addNotice(error instanceof Error ? error.message : String(error));
					if (!inputProcessed) { this.queued.unshift(current); inputProcessed = true; }
					this.pauseSending();
				}
				if (this.switching) {
					if (!inputProcessed) this.queued.unshift(current);
					this.pauseSending(); break;
				}
				if (this.autoSendPaused) {
					this.restoreInputs(this.queued.splice(0));
					current = this.replacement;
					this.replacement = undefined;
					this.autoSendPaused = false;
				} else current = this.queued.shift();
				if (current !== undefined && this.dispatchCommand(current)) current = this.queued.shift();
			}
		} finally {
			this.running = false;
			this.repaint();
		}
	}

	private handleEvent(event: SessionEvent): void {
		if (event.type === "compaction") this.projector.addNotice(`Context ${event.phase}${event.error ? ": " + event.error : ""}`);
		if (event.type === "retry") this.projector.addNotice(`Model retry ${event.phase} #${event.attempt}${event.delayMs !== undefined ? ` in ${event.delayMs}ms` : ""}${event.outcome ? `: ${event.outcome}` : ""}`);
		if (event.type === "recovery") this.projector.addNotice(`Context recovery: ${event.reason}`);
		this.projector.apply(event);
		if (event.type === "message_end" && event.message.errorMessage) this.projector.addNotice(event.message.errorMessage);
		if (event.type === "turn_end" && (event.stopReason === "error" || event.stopReason === "aborted")) this.projector.addNotice(`turn ${event.stopReason}`);
		this.repaint();
	}

	private selectEntry(delta: number): void {
		const entries = this.presentations(this.screen().columns);
		const current = entries.findIndex((entry) => entry.id === this.selectedId);
		this.selectedId = entries[Math.max(0, Math.min(entries.length - 1, current + delta))]?.id;
		const metrics = this.transcriptMetrics();
		const span = metrics.spans.find((item) => item.entryId === this.selectedId);
		if (!span) return;
		const top = Math.max(0, metrics.totalRows - metrics.viewportHeight - this.scroll.offset);
		if (span.start < top || span.start >= top + metrics.viewportHeight) this.setTranscriptTop(span.start);
	}

	private openDetail(): void {
		this.scroll.hold();
		const group = this.presentations(this.screen().columns).find((view) => view.id === this.selectedId)?.members;
		if (group) {
			for (const member of group) this.expandedGroups.add(member.id);
			this.selectedId = group[0]?.id;
			return;
		}
		const entry = this.selectedId ? this.projector.getEntry(this.selectedId) : undefined;
		if (entry) this.viewer = new DetailView(entry.id, entryDetail(entry));
	}

	private copyText(text: string): void {
		if (!text) return;
		const version = ++this.copyVersion;
		void this.host.requestCopy(text).catch(() => "unavailable" as const).then((result) => {
			if (!this.started || version !== this.copyVersion) return;
			this.feedback = result === "copied" ? "Copied" : result === "requested" ? "Copy requested" : "Clipboard unavailable";
			clearTimeout(this.feedbackTimer);
			this.feedbackTimer = setTimeout(() => { this.feedback = undefined; this.selectionFlash = undefined; this.repaint(); }, 1200);
			this.repaint();
		});
	}

	private setTranscriptTop(top: number): void {
		const metrics = this.transcriptMetrics();
		const max = Math.max(0, metrics.totalRows - metrics.viewportHeight);
		this.scroll.scrollBy(max - top - this.scroll.offset, max);
		this.scroll.hold();
		this.previousTranscript = undefined;
	}

	private foldSelected(mode?: "collapsed" | "expanded"): void {
		if (this.selectedId?.startsWith("group:")) {
			const metrics = this.transcriptMetrics();
			const top = Math.max(0, metrics.totalRows - metrics.viewportHeight - this.scroll.offset);
			const members = this.presentations(this.screen().columns).find((view) => view.id === this.selectedId)?.members ?? [];
			const close = mode === "collapsed" || mode === undefined && members.some((member) => this.expandedGroups.has(member.id));
			for (const member of members) {
				if (close) this.expandedGroups.delete(member.id);
				else this.expandedGroups.add(member.id);
			}
			this.setTranscriptTop(top);
			return;
		}
		const entry = this.selectedId ? this.projector.getEntry(this.selectedId) : undefined;
		if (!entry) return;
		if (entry.kind !== "tool" && entry.kind !== "thinking" && entry.kind !== "execute" && entry.kind !== "edit") return;
		const metrics = this.transcriptMetrics();
		const top = Math.max(0, metrics.totalRows - metrics.viewportHeight - this.scroll.offset);
		const current = entry.kind === "tool" ? entry.displayMode : entry.block.currentDisplayMode ?? entry.block.defaultDisplayMode ?? entry.block.fold.defaultDisplayMode ?? "expanded";
		const next = mode ?? (current === "collapsed" ? entry.kind === "tool" && entry.name === "read" ? "truncated" : "expanded" : "collapsed");
		const previousStart = metrics.spans.find((span) => span.entryId === entry.id)?.start ?? 0;
		this.projector.setEntryDisplayState(entry.id, next, true);
		const nextStart = this.transcriptMetrics().spans.find((span) => span.entryId === entry.id)?.start ?? previousStart;
		this.setTranscriptTop(top + nextStart - previousStart);
	}

	private handleMouse(key: Extract<Key, { type: "mouse" }>): void {
		const screen = this.screen();
		key = { ...key, x: key.x - screen.x, y: key.y - screen.y };
		if (key.action === "release" || key.action === "drag") {
			if (this.selection) {
				this.selection.move(key);
				if (this.selection.moved) this.lastClick = undefined;
				if (key.action === "release") {
					this.copyText(this.selection.text());
					this.selectionFlash = this.selection.moved ? this.selection : undefined;
					this.selection = undefined;
				}
				this.repaint();
			}
			return;
		}
		if (key.x < 0 || key.y < 0 || key.x >= screen.columns || key.y >= screen.rows) return;
		if (this.viewer) {
			if (key.action === "click" && key.y > 0 && key.y < screen.rows - 2) this.startSelection(key, 1, screen.rows - 2, 1);
			else this.viewer.handleKey(key);
			this.repaint(); return;
		}
		const plan = this.layoutPlan(screen.columns, screen.rows, this.statusSegments().length > 0);
		const offsets = layoutOffsets(plan);
		const { totalRows, viewportHeight, spans } = this.transcriptMetrics();
		if (key.x >= this.host.columns || key.y >= this.host.rows) return;
		const card = this.visibleCard();
		const interactive = this.interactiveRegion;
		if (!card && key.action === "click" && interactive && key.x >= interactive.x && key.x < interactive.x + interactive.width && key.y >= interactive.y && key.y < interactive.y + interactive.height) {
			this.browsing = false;
			this.refreshSuggestions();
			this.repaint();
			return;
		}
		if (card && key.y >= offsets.interactive && key.y < offsets.interactive + plan.interactive.height) {
			if (key.action === "up" || key.action === "down") card.bodyOffset = Math.max(0, card.bodyOffset + (key.action === "down" ? 3 : -3));
		} else if (key.action === "up" || key.action === "down") {
			this.scroll.scrollBy(key.action === "up" ? 3 : -3, Math.max(0, totalRows - viewportHeight));
			this.scroll.hold();
		} else if (!this.picker && key.y >= offsets.transcript && key.y < offsets.transcript + viewportHeight) {
			const windowTop = Math.max(0, totalRows - viewportHeight - this.scroll.offset);
			const targetRow = windowTop + key.y - offsets.transcript;
			const span = spans.find((candidate) => candidate.start <= targetRow && targetRow < candidate.start + candidate.height);
			const entry = span && this.presentations(screen.columns).find((view) => view.id === span.entryId);
			if (entry) {
				if (this.focus.active) {
					const parked = this.focus.park();
					if (parked) this.cards.get(parked.id)?.park();
				}
				this.browsing = true;
				this.selectedId = entry.id;
				this.scroll.hold();
				const now = Date.now();
				if (span?.start === targetRow && this.lastClick?.id === entry.id && now - this.lastClick.at <= 400) {
					this.foldSelected(); this.lastClick = undefined;
				} else this.lastClick = span?.start === targetRow ? { id: entry.id, at: now } : undefined;
				const source = this.projector.getEntry(entry.id);
				const textEntry = source?.kind === "assistant" || source?.kind === "user" || source?.kind === "notice";
				if (span && (targetRow > span.start || textEntry) && key.x >= 3) this.startSelection(key, offsets.transcript, offsets.transcript + viewportHeight, 3);
			}
		}
		this.repaint();
	}

	private startSelection(point: { x: number; y: number }, top: number, bottom: number, left: number): void {
		const { x, y, columns, rows } = this.screen();
		const full = this.composeFrame();
		const snapshot = createFrame(columns, rows);
		for (let row = 0; row < rows; row++) snapshot.cells[row] = full.cells[row + y]!.slice(x, x + columns);
		this.selection = new TextSelection(point, snapshot, { top, bottom, left, right: columns - (this.viewer ? 1 : 2) });
	}

	private scrollPage(direction: 1 | -1): void {
		const { totalRows, viewportHeight } = this.transcriptMetrics();
		this.scroll.pageBy(direction, viewportHeight, Math.max(0, totalRows - viewportHeight));
		this.scroll.hold();
	}

	private transcriptMetrics(): { totalRows: number; viewportHeight: number; spans: EntrySpan[] } {
		const { columns, rows } = this.screen();
		const segments = this.statusSegments();
		const plan = this.layoutPlan(columns, rows, segments.length > 0);
		const presentations = this.presentations(columns);
		let start = 0;
		const spans: EntrySpan[] = presentations.map((presentation) => {
			const height = entryHeight(presentation.presentation);
			const span = { entryId: presentation.id, start, height, rowSources: [
				...Array.from({ length: presentation.presentation.chrome.vpadTop }, () => undefined),
				...presentation.presentation.rows.map((row) => row.source),
			] };
			start += height;
			return span;
		});
		return { totalRows: start, viewportHeight: plan.transcript.height, spans };
	}

	private presentations(columns: number) {
		const views = transcriptViews(this.projector.getEntries(), columns, this.theme, this.expandedGroups);
		for (const view of views) {
			if (view.members?.some((member) => this.expandedGroups.has(member.id))) {
				for (const member of view.members) this.expandedGroups.add(member.id);
			}
		}
		if (this.selectedId && !views.some((view) => view.id === this.selectedId)) {
			const memberId = this.selectedId.startsWith("group:") ? this.selectedId.slice(6) : this.selectedId;
			this.selectedId = views.find((view) => view.id === memberId || view.members?.some((member) => member.id === memberId))?.id;
		}
		return views;
	}

	private statusSegments(): string[] {
		const usage = this.port.getUsage?.();
		const cost = usage?.costUsd;
		return buildStatusSegments({
			...(cost !== undefined ? { cost } : {}),
		});
	}

	private contextLabel(usage: ContextUsageSnapshot | undefined): string | undefined {
		if (usage?.contextTokens === undefined) return undefined;
		return `${usage.contextEstimated ? "~" : ""}${formatTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ""}`;
	}

	private layoutPlan(columns: number, rows: number, hasStatus: boolean) {
		const card = this.visibleCard();
		const interactiveOwner = card ? ("card" as const) : ("composer" as const);
		const emptyWelcome = this.options.showWelcome && !this.submitted && this.projector.getEntries().length === 0;
		const width = emptyWelcome ? Math.min(75, Math.max(4, columns - 2)) : columns;
		const wrapped = wrapDraft(this.draft, Math.max(1, width - 6));
		const interactiveLines = card
			? cardDesiredHeight(card.record.request, columns, this.theme)
			: this.browsing ? 1 : Math.max(1, wrapped.cursorY + 1, wrapped.lines.length);
		return computeScreenLayout({ columns, rows, interactiveLines, hasStatus, interactiveOwner, activityLines: this.activityLines(columns).length, compact: this.host.rows <= 20, tiny: this.host.rows <= 16 });
	}

	private screen() {
		const x = this.host.columns < 8 ? 0 : this.host.rows <= 20 ? 1 : 2;
		const y = this.host.rows <= 20 ? 0 : 1;
		return { x, y, columns: Math.max(1, this.host.columns - x * 2), rows: Math.max(1, this.host.rows - y * 2) };
	}

	private surround(content: TerminalFrame): TerminalFrame {
		const { x, y } = this.screen();
		const background = this.theme.color("base");
		const frame = createFrame(this.host.columns, this.host.rows, { ...defaultStyle(), background });
		for (let row = 0; row < content.rows; row++) for (let column = 0; column < content.columns; column++) {
			const cell = content.cells[row]![column]!;
			if (frame.cells[row + y]?.[column + x]) frame.cells[row + y]![column + x] = cell.background.kind === "default" ? { ...cell, background } : cell;
		}
		if (content.cursor) frame.cursor = { ...content.cursor, x: content.cursor.x + x, y: content.cursor.y + y };
		return frame;
	}

	private repaint(): void {
		if (!this.started) return;
		this.host.paint(this.composeFrame());
	}

	private queueLines(columns: number): string[] {
		const pending = this.queued.map((input, index) => `Queued ${index + 1}: ${input}`);
		if (this.replacement !== undefined) pending.push(`Next: ${this.replacement}`);
		return pending.flatMap((input) => wrapText(input, Math.max(1, columns - 2)));
	}
	private activityLines(columns: number): string[] {
		return [...(this.switching ? ["正在切换会话…"] : this.menuLoading ? ["正在读取会话…"] : []), ...this.queueLines(columns), ...(this.compactTask ? ["compacting"] : this.running ? [this.autoSendPaused ? "stopping" : "working"] : []), ...(this.feedback ? [this.feedback] : [])];
	}

	/** Compose the current frame. Pure w.r.t. the terminal; exposed for tests. */
	composeFrameForTest(): TerminalFrame {
		return this.composeFrame();
	}

	private composeFrame(): TerminalFrame {
		const { columns, rows } = this.screen();
		const frame = createFrame(columns, rows);
		if (this.sessionMenu) { this.sessionMenu.paint(frame, this.theme); return this.surround(frame); }
		if (this.viewer) {
			const entry = this.projector.getEntry(this.viewer.entryId);
			if (entry) this.viewer.update(entryDetail(entry));
			this.viewer.paint(frame, this.theme, this.feedback);
			(this.selection ?? this.selectionFlash)?.paint(frame);
			return this.surround(frame);
		}
		const segments = this.statusSegments();
		const plan = this.layoutPlan(columns, rows, segments.length > 0);
		const offsets = layoutOffsets(plan);
		const transcriptHeight = plan.transcript.height;
		if (plan.header.height === 1) {
			const contextLabel = this.contextLabel(this.port.getUsage?.());
			paintHeader(frame, offsets.header, { cwd: this.options.cwd, homeDir: this.options.homeDir, ...(contextLabel ? { contextLabel } : {}) }, this.theme);
		}
		const entries = this.projector.getEntries();
		const welcome = (this.options.showWelcome ?? false) && !this.submitted && entries.length === 0 && !this.visibleCard();
		let composerY = offsets.interactive;
		let composerX = 0;
		let composerWidth = columns;
		if (welcome) {
			const logoRows = welcomeHeight(columns, transcriptHeight);
			const top = offsets.transcript + Math.max(0, Math.floor((transcriptHeight - logoRows - 1) / 2));
			paintWelcome(frame, top, logoRows, { cwd: this.options.cwd, homeDir: this.options.homeDir }, this.theme);
			composerY = Math.min(offsets.interactive, top + logoRows + 1);
			composerWidth = Math.min(75, Math.max(4, columns - 2));
			composerX = Math.max(0, Math.floor((columns - composerWidth) / 2));
		} else {
			this.paintTranscriptRegion(frame, offsets.transcript, transcriptHeight);
		}
		const activityLines = this.activityLines(columns);
		for (let row = 0; row < plan.activity.height; row++) {
			const text = row === plan.activity.height - 1 && activityLines.length > plan.activity.height ? `... (${this.queued.length} queued)${this.running ? " working" : ""}` : activityLines[row]!;
			writeText(frame, 1, offsets.activity + row, text, { ...defaultStyle(), foreground: this.theme.color("activity") });
		}
		if (this.picker && plan.interactive.owner === "composer") {
			const height = pickerHeight(this.picker.items.length, Math.min(8, Math.max(0, composerY - offsets.transcript)));
			paintPicker(frame, composerY - height, height, this.picker, this.theme);
		}
		const card = this.visibleCard();
		this.interactiveRegion = { x: composerX, y: card ? offsets.interactive : composerY, width: composerWidth, height: plan.interactive.height };
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
				x: composerX,
				y: composerY,
				width: composerWidth,
				height: plan.interactive.height,
				draft: this.draft,
				theme: this.theme,
				placeholder: "Type a message",
				caption: this.options.getStatus ? `${this.options.getStatus().provider}/${this.options.getStatus().model}` : undefined,
				focused: !this.browsing,
				compact: plan.compact,
			});
		}
		if (plan.status.height === 1) paintStatus(frame, offsets.status, segments, this.theme);
		if (this.browsing || this.focus.hasParked) delete frame.cursor;
		if (plan.shortcuts.height === 1) {
			const routes = shortcutRoutes(this.routerState());
			const hints: ShortcutHint[] = routes.map((route) => ({ keys: route.keys, label: route.label, ...(route.pinned ? { pinned: true } : {}) }));
			paintShortcuts(frame, offsets.shortcuts, hints, this.theme);
		}
		(this.selection ?? this.selectionFlash)?.paint(frame);
		return this.surround(frame);
	}

	private paintTranscriptRegion(frame: TerminalFrame, top: number, height: number): void {
		if (height <= 0) return;
		const presentations = this.presentations(frame.columns);
		let start = 0;
		const spans: EntrySpan[] = presentations.map((presentation) => {
			const span = { entryId: presentation.id, start, height: entryHeight(presentation.presentation), rowSources: [
				...Array.from({ length: presentation.presentation.chrome.vpadTop }, () => undefined),
				...presentation.presentation.rows.map((row) => row.source),
			] };
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
			if (this.browsing && span.entryId === this.selectedId) {
				const view = presentations[index]!;
				const y = Math.max(top, top + span.start + view.presentation.chrome.vpadTop - windowTop);
				if (view.dense) {
					for (let x = 1; x < frame.columns - 1; x++) {
						const cell = frame.cells[y]![x]!;
						cell.background = this.theme.color("dark_surface");
					}
				}
				writeText(frame, view.dense ? 3 : 1, y, ">", { ...defaultStyle(), foreground: this.theme.color("status"), ...(view.dense ? { background: this.theme.color("dark_surface") } : {}) });
			}
		}
		const selected = this.browsing ? presentations.findIndex((view) => view.id === this.selectedId) : -1;
		if (selected >= 0) {
			const unit = presentations[selected]!.selectionGroup;
			const selectedSpans = spans.filter((_span, index) => index === selected || unit !== undefined && presentations[index]!.selectionGroup === unit);
			const first = selectedSpans[0]!;
			const last = selectedSpans.at(-1)!;
			const firstIndex = spans.indexOf(first);
			const firstChrome = presentations[firstIndex]!.presentation.chrome;
			const start = top + first.start + firstChrome.vpadTop - windowTop;
			const previousChrome = presentations[firstIndex - 1]?.presentation.chrome;
			const hasTopGap = firstChrome.vpadTop > 0 || !previousChrome || (previousChrome.gapAfter ?? 0) > 0 || !previousChrome.surface && previousChrome.vpadBottom > 0;
			const lastChrome = presentations.find((view) => view.id === last.entryId)!.presentation.chrome;
			const lastPadding = lastChrome.vpadBottom + (lastChrome.gapAfter ?? 0);
			const end = top + last.start + last.height - lastPadding - windowTop;
			const style = { ...defaultStyle(), foreground: this.theme.color("prompt_border_active") };
			const borderTop = hasTopGap ? start - 1 : start;
			const borderBottom = lastPadding > 0 ? end : end - 1;
			for (let y = Math.max(top, borderTop); y <= Math.min(top + height - 1, borderBottom); y++) {
				const clipped = y === top && start < top || y === top + height - 1 && end >= top + height;
				writeText(frame, 0, y, clipped ? "┆" : y === start - 1 ? "┌" : y === end ? "└" : "│", style);
				writeText(frame, frame.columns - 1, y, clipped ? "┆" : y === start - 1 ? "┐" : y === end ? "┘" : "│", style);
			}
		}
	}

	private async consumeRequests(): Promise<void> {
		const bus = this.requestBus;
		const generation = this.generation;
		try {
			for await (const envelope of bus.requests()) {
				if (!this.started || generation !== this.generation) return;
				const card = new RequestCard(envelope);
				const terminal = bus.getTerminal?.(envelope.id);
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
			if (generation === this.generation && !this.switching) await this.stop();
		}
	}

	private async consumeTerminals(): Promise<void> {
		const bus = this.requestBus;
		const generation = this.generation;
		try {
			for await (const outcome of bus.terminals()) {
				if (!this.started || generation !== this.generation) return;
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
			if (generation === this.generation && !this.switching) await this.stop();
		}
	}

	private get port(): AppPort { return this.session?.port ?? this.options.port; }
	private get requestBus(): AppRequestBus {
		return this.session?.requestBus ?? this.options.requestBus;
	}
}

/** Compact token totals for the header (13K / 1.0M style). */
export function formatTokens(total: number): string {
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
	if (total >= 1_000) return `${Math.round(total / 1_000)}K`;
	return String(total);
}
