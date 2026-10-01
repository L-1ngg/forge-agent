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
import { TranscriptBrowser } from "./transcript/browser.ts";
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
import { TextSelection } from "./text-selection.ts";
import { SessionMenu } from "./session-menu.ts";

import { InteractionScope } from "@forge-agent/interaction/scope";
import type { InteractionEvent, InteractionPort, SessionCoordinator } from "@forge-agent/interaction";
import type { AppOptions } from "./app.ts";
/** One activation owns all transient presentation and display effects. */
export class PresentationSession<P extends InteractionPort = InteractionPort> {
	readonly draft: EditorState = createEditor();
	private readonly projector = new TranscriptProjector();
	private readonly browser: TranscriptBrowser;
	private readonly focus = new FocusStack<RequestCardRecord>();
	private readonly cards = new Map<string, RequestCard>();
	private sessionMenu: SessionMenu | undefined;
	private menuLoading = false;
	private pendingTarget: string | undefined;
	private browsing = false;
	private viewer: DetailView | undefined;
	private submitted = false;
	private selection: TextSelection | undefined;
	private selectionFlash: TextSelection | undefined;
	private feedback: string | undefined;
	private feedbackScope: InteractionScope | undefined;
	private interactiveRegion: { x: number; y: number; width: number; height: number } | undefined;
	private picker: PickerState | undefined;
	private readonly scope = new InteractionScope();
	private effects = this.scope.child();

	constructor(private readonly options: AppOptions<P>, private readonly host: Host, private readonly theme: Theme, private readonly coordinator: SessionCoordinator<P>, private readonly onRepaint: () => void, private readonly onQuit: () => void, history: readonly SessionMessage[], draft: string, hasHistory?: boolean) {
		for (const message of history) this.projector.apply({ type: "message_end", message, timestamp: message.timestamp });
		this.browser = new TranscriptBrowser(this.projector, theme);
		replaceEditor(this.draft, draft, draft.length);
		this.submitted = hasHistory ?? history.length > 0;
	}
	private get running(): boolean { return this.coordinator.snapshot().activity !== "idle"; }
	private get compacting(): boolean { return this.coordinator.snapshot().activity === "compacting"; }
	private get switching(): boolean { return this.coordinator.snapshot().phase === "switching"; }
	private suspend(): void {
		this.effects.dispose(); this.picker = undefined; this.sessionMenu = undefined; this.menuLoading = false;
		this.feedback = undefined; this.selectionFlash = undefined;
	}
	dispose(): void {
		const errors = this.scope.dispose();
		if (errors.length) throw new AggregateError(errors, "Presentation cleanup failed");
	}

	private routerState(): InputRouterState {
		const top = this.focus.top();
		const parked = this.focus.parkedTop();
		return {
			cardFocused: this.focus.active,
			cardParked: !this.focus.active && this.focus.hasParked,
			cardKind: (top ?? parked)?.request.kind,
			cardSubInput: this.focus.active && !!top && (requestCardActions(top.request)[this.focus.focusIndex] === "answer_text" || requestCardActions(top.request)[this.focus.focusIndex]?.startsWith("field:")),
			editorFocused: !this.browsing,
			running: this.running,
			selectedCanView: this.browser.canView,
			selectedCanFold: this.browser.canFold,
		};
	}

	private visibleCard(): RequestCard | undefined {
		const record = this.focus.top() ?? (this.browsing ? this.focus.parkedTop() : undefined);
		return record ? this.cards.get(record.id) : undefined;
	}

	handleKey(key: Key): void {
		if (isCtrlC(key)) {
			this.onQuit();
			return;
		}
		if (this.switching) return;
		if (this.sessionMenu) {
			const action = this.sessionMenu.handleKey(key);
			if (action?.type === "cancel") { this.coordinator.cancelData("sessions"); this.coordinator.cancelData("preview"); this.menuLoading = false; this.sessionMenu = undefined; this.pendingTarget = undefined; }
			if (action?.type === "select") { this.coordinator.cancelData("sessions"); this.coordinator.cancelData("preview"); this.sessionMenu = undefined; this.requestSwitch(action.id); }
			if (action?.type === "preview") { const cached = this.sessionMenu?.cachedPreview(action.id); this.coordinator.requestData({ kind: "preview", id: action.id, ...(cached ? { cached } : {}) }); }
			if (action?.type === "cancel_preview") this.coordinator.cancelData("preview");
			if (action?.type === "discard") { this.sessionMenu = undefined; this.coordinator.switchTo(this.pendingTarget); }
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
        if (key.type === "escape" && card?.record.request.kind === "mcp_elicitation") { this.chooseAction(requestCardActions(card.record.request).indexOf("cancel")); return; }
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
		const result = this.focus.handleKey(key.type === "ctrl" && key.key === "p" && card?.record.request.kind === "mcp_elicitation" ? { type: "escape" } : key);
		if (result.action === "park" && result.card) {
			this.cards.get(result.card.id)?.park();
			this.browsing = true;
			this.transcript().enter();
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
		if (this.focus.hasParked && key.type === "char" && key.text === "c") {
			this.browsing = false;
			this.repaint();
			return;
		}
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
			if (nextEscStep(this.routerState()) === "abort_turn") { this.coordinator.interrupt(); }
			this.repaint();
			return;
		}
		if (key.type === "pageUp") this.transcript().scrollPage(1);
		else if (key.type === "pageDown") this.transcript().scrollPage(-1);
		else if (key.type === "enter" || (key.type === "ctrl" && key.key === "f")) this.openDetail();
		else if (key.type === "arrow") {
			if (key.direction === "up" || key.direction === "down") this.transcript().moveSelection(key.direction === "up" ? -1 : 1);
			else this.transcript().fold(key.direction === "left" ? "collapsed" : "expanded");
		} else if (key.type === "char") {
			if (key.text === "j" || key.text === "k") this.transcript().moveSelection(key.text === "k" ? -1 : 1);
			else if (key.text === "e") this.transcript().fold();
			else if (key.text === "h" || key.text === "l") this.transcript().fold(key.text === "h" ? "collapsed" : "expanded");
			else if (key.text === "G") this.browser.jumpToEnd();
			else if (key.text === "y" || key.text === "Y") {
				const entry = this.browser.selectedEntry;
				if (entry) { const detail = entryDetail(entry); this.copyText(key.text === "Y" ? detail.metadata : detail.lines.join("\n")); }
			}
		}
		this.repaint();
	}

	private handleComposerKey(key: Key): void {
		if (this.picker && this.handlePickerKey(key)) return;
		if (key.type === "tab") {
			const parked = this.focus.resume();
			if (parked) {
				this.cards.get(parked.id)?.resume();
				this.repaint();
				return;
			}
			this.browsing = true;
			this.transcript().enter();
			this.coordinator.cancelData("suggestions");
			this.repaint();
			return;
		}
		if (key.type === "ctrlEnter") {
			this.cancelAndSend();
			return;
		}
		if (key.type === "escape") {
			if (nextEscStep(this.routerState()) === "abort_turn") {
				this.coordinator.interrupt();
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
					const recalled = isEditorEmpty(this.draft) ? this.coordinator.recallInput() : undefined;
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
				this.transcript().scrollPage(1);
				break;
			case "pageDown":
				this.transcript().scrollPage(-1);
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
			this.coordinator.cancelData("suggestions");
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
		const picker = this.picker, item = picker?.items[picker.index];
		if (!picker || !item) return;
		this.coordinator.cancelData("suggestions");
		const applied = this.coordinator.applyCompletion(editorText(this.draft), editorCursorOffset(this.draft), item, picker.prefix);
		replaceEditor(this.draft, applied.input, applied.cursor);
		this.picker = undefined; this.refreshSuggestions(); this.repaint();
	}
	private refreshSuggestions(): void {
		this.picker = undefined;
		this.coordinator.requestData({ kind: "suggestions", input: editorText(this.draft), cursor: editorCursorOffset(this.draft) });
	}

	private chooseAction(index: number): void {
		this.coordinator.reconcileRequests();
		const record = this.focus.top();
		const card = record ? this.cards.get(record.id) : undefined;
		if (!card) return;
		const action = requestCardActions(card.record.request)[index];
		if (action === "open_url" && card.record.request.kind === "mcp_elicitation" && card.record.request.payload.url) {
			const url = card.record.request.payload.url;
			this.effects.run("open_url", "reject", { work: () => this.options.openExternal?.(url), error: error => { this.projector.addNotice(String(error)); this.repaint(); } }); return;
		}
		if (!action) return;
		const envelope = card.responseFor(action);
		if (!envelope) {
			this.repaint();
			return;
		}
		if (!this.coordinator.respond(envelope)) return;
		card.markResolved(envelope.result);
		this.focus.remove(card.record.id);
		this.cards.delete(card.record.id);
		this.projector.addNotice(archivedCardLine(card.record));
		this.repaint();
	}

	private submit(): void {
		if (isEditorEmpty(this.draft)) { this.repaint(); return; }
		let input = submitEditor(this.draft);
		const [firstLine, ...rest] = input.split("\n");
		if (["/new", "/resume"].includes(firstLine!.trim()) && rest.length) {
			input = firstLine!.trim();
			const remaining = rest.join("\n"); replaceEditor(this.draft, remaining, remaining.length);
		}
		this.coordinator.cancelData("suggestions"); this.picker = undefined;
		this.coordinator.submit(input, "queue"); this.repaint();
	}
	private cancelAndSend(): void {
		if (isEditorEmpty(this.draft) && !this.running) return;
		const input = isEditorEmpty(this.draft) ? "" : submitEditor(this.draft);
		this.coordinator.cancelData("suggestions"); this.picker = undefined;
		this.coordinator.submit(input, "replace"); this.repaint();
	}
	private restoreInputs(inputs: readonly string[]): void {
		if (!inputs.length) return;
		const text = [...inputs, ...(!isEditorEmpty(this.draft) ? [editorText(this.draft)] : [])].join("\n\n");
		replaceEditor(this.draft, text, text.length);
		this.coordinator.cancelData("suggestions"); this.picker = undefined;
	}
	private openSessions(): void {
		if (!this.coordinator.snapshot().canSwitch) { this.projector.addNotice("Session switching unavailable"); return; }
		this.menuLoading = true;
		this.sessionMenu = new SessionMenu("list", [], [], this.coordinator.snapshot().sessionId, true);
		this.coordinator.requestData({ kind: "sessions" }); this.repaint();
	}
	private requestSwitch(id?: string): void {
		const snapshot = this.coordinator.snapshot();
		if (!snapshot.canSwitch) { this.projector.addNotice("Session switching unavailable"); return; }
		if (id === snapshot.sessionId || snapshot.phase !== "active") return;
		if (snapshot.hasHistory === false && (!isEditorEmpty(this.draft) || snapshot.hasPendingInputs)) {
			this.pendingTarget = id; this.sessionMenu = new SessionMenu("discard"); return;
		}
		this.coordinator.switchTo(id);
	}
	handleInteraction(event: InteractionEvent): void {
		switch (event.type) {
			case "session_event": this.handleEvent(event.event); break;
			case "notice": this.projector.addNotice(event.text); break;
			case "restore_inputs": this.restoreInputs(event.inputs); break;
			case "interaction_invalidated": this.suspend(); break;
			case "interaction_ready": this.effects = this.scope.child(); break;
			case "state_changed": if (event.snapshot.activity !== "idle") this.submitted = true; break;
			case "request_added": {
				const card = new RequestCard(event.request);
				this.cards.set(event.request.id, card); this.focus.push(card.record); break;
			}
			case "request_ended": {
				const card = this.cards.get(event.requestId);
				if (card) {
					if (event.outcome) { card.terminal(event.outcome); this.projector.addNotice(archivedCardLine(card.record)); }
					else this.projector.addNotice(`Request ${event.requestId} ended; its recent outcome is no longer retained.`);
					this.focus.remove(event.requestId); this.cards.delete(event.requestId);
				}
				break;
			}
			case "data_result": {
				const result = event.result;
				if (result.kind === "suggestions") this.picker = result.status === "success" && result.value?.items.length ? { items: result.value.items, prefix: result.value.prefix, index: 0 } : undefined;
				if (result.kind === "sessions") {
					this.menuLoading = false;
					if (result.status === "success") this.sessionMenu?.setList(result.value.sessions, result.value.diagnostics);
					else this.sessionMenu?.setList([], [result.message]);
				}
				if (result.kind === "preview") {
					if (result.status === "success") this.sessionMenu?.setPreview(result.value);
					else this.sessionMenu?.setPreview(undefined, result.message);
				}
				break;
			}
			case "view_command":
				if (event.command === "new") this.requestSwitch();
				else if (event.command === "resume") this.openSessions();
				else if (event.command === "quit") this.onQuit();
				else if (event.command === "clear") { this.projector.clear(); this.browser.reset(); this.projector.addNotice("已清屏，上下文仍保留"); }
				else this.projector.addNotice("/help · /clear · /new · /resume · /compact · /memory · /mcp · /skills · /skill <name> [task] · /quit · @file to mention");
				break;
		}
		this.repaint();
	}

	private handleEvent(event: SessionEvent): void {
		if (event.type === "skill_input") this.projector.addNotice(`Skill ${event.name}: ${event.code}: ${event.message}`);
		if (event.type === "memory") {
			if (event.phase === "save" && event.status === "failed") for (const receipt of event.receipts) if (!receipt.ok) this.projector.addNotice(`Memory save failed: ${receipt.error ?? "unknown error"}`);
		}
		if (event.type === "compaction") this.projector.addNotice(`Context ${event.phase}${event.error ? ": " + event.error : ""}`);
		if (event.type === "retry") this.projector.addNotice(`Model retry ${event.phase} #${event.attempt}${event.delayMs !== undefined ? ` in ${event.delayMs}ms` : ""}${event.outcome ? `: ${event.outcome}` : ""}`);
		if (event.type === "recovery") this.projector.addNotice(`Context recovery: ${event.reason}`);
		this.projector.apply(event);
		if (event.type === "message_end" && event.message.errorMessage) this.projector.addNotice(event.message.errorMessage);
		if (event.type === "turn_end" && (event.stopReason === "error" || event.stopReason === "aborted")) this.projector.addNotice(`turn ${event.stopReason}`);
		this.repaint();
	}

	private openDetail(): void {
		const entry = this.transcript().openDetail();
		if (entry) {
			this.viewer = new DetailView(entry.id, entryDetail(entry));
			const screen = this.screen(); this.viewer.reconcile(screen.columns, screen.rows, this.theme);
		}
	}

	private copyText(text: string): void {
		if (!text) return;
		this.effects.run("copy", "replace", {
			work: () => this.host.requestCopy(text).catch(() => "unavailable" as const),
			success: result => {
				this.feedback = result === "copied" ? "Copied" : result === "requested" ? "Copy requested" : "Clipboard unavailable";
				this.feedbackScope?.dispose();
				const scope = this.feedbackScope = this.effects.child();
				const timer = setTimeout(() => {
					if (scope.active) { this.feedback = undefined; this.selectionFlash = undefined; this.repaint(); }
					scope.dispose();
				}, 1200);
				scope.defer(() => clearTimeout(timer)); this.repaint();
			},
		});
	}

	private handleMouse(key: Extract<Key, { type: "mouse" }>): void {
		const screen = this.screen();
		key = { ...key, x: key.x - screen.x, y: key.y - screen.y };
		if (key.action === "release" || key.action === "drag") {
			if (this.selection) {
				this.selection.move(key);
				if (this.selection.moved) this.browser.cancelClick();
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
		const browser = this.transcript();
		const viewportHeight = plan.transcript.height;
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
			browser.scrollBy(key.action === "up" ? 3 : -3);
		} else if (!this.picker && key.y >= offsets.transcript && key.y < offsets.transcript + viewportHeight) {
			const hit = browser.click(key.y - offsets.transcript, Date.now());
			if (hit) {
				if (this.focus.active) {
					const parked = this.focus.park();
					if (parked) this.cards.get(parked.id)?.park();
				}
				this.browsing = true;
				if (hit.selectText && key.x >= 3) this.startSelection(key, offsets.transcript, offsets.transcript + viewportHeight, 3);
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

	private transcript(): TranscriptBrowser {
		const { columns, rows } = this.screen();
		const plan = this.layoutPlan(columns, rows, this.statusSegments().length > 0);
		this.browser.update(columns, plan.transcript.height);
		return this.browser;
	}

	private statusSegments(): string[] {
		const usage = this.coordinator.snapshot().usage;
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
		const emptyWelcome = this.options.showWelcome && !this.submitted && this.projector.getSnapshot().entries.length === 0;
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

	private repaint(): void { this.onRepaint(); }

	private queueLines(columns: number): string[] {
		const pending = this.coordinator.snapshot().inputLabels;
		return pending.flatMap((input) => wrapText(input, Math.max(1, columns - 2)));
	}
	private activityLines(columns: number): string[] {
		return [...(this.switching ? ["正在切换会话…"] : this.menuLoading ? ["正在读取会话…"] : []), ...this.queueLines(columns), ...(this.compacting ? ["compacting"] : this.running ? [(this.coordinator.snapshot().activity === "stopping") ? "stopping" : "working"] : []), ...(this.feedback ? [this.feedback] : [])];
	}

	composeFrame(): TerminalFrame {
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
			const contextLabel = this.contextLabel(this.coordinator.snapshot().usage);
			paintHeader(frame, offsets.header, { cwd: this.options.cwd, homeDir: this.options.homeDir, ...(contextLabel ? { contextLabel } : {}) }, this.theme);
		}
		const snapshot = this.projector.getSnapshot(), entries = snapshot.entries;
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
			this.browser.update(columns, transcriptHeight, snapshot);
			this.browser.paint(frame, offsets.transcript, this.browsing);
		}
		const activityLines = this.activityLines(columns);
		for (let row = 0; row < plan.activity.height; row++) {
			const text = row === plan.activity.height - 1 && activityLines.length > plan.activity.height ? `... (${this.coordinator.snapshot().queuedCount} queued)${this.running ? " working" : ""}` : activityLines[row]!;
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
				placeholder: this.switching ? "正在切换会话…" : "Type a message",
				caption: this.options.getStatus ? `${this.options.getStatus().provider}/${this.options.getStatus().model}` : undefined,
				focused: !this.browsing,
				compact: plan.compact,
			});
		}
		if (plan.status.height === 1) paintStatus(frame, offsets.status, segments, this.theme);
		if (this.browsing) delete frame.cursor;
		if (plan.shortcuts.height === 1) {
			const routes = shortcutRoutes(this.routerState());
			const hints: ShortcutHint[] = routes.map((route) => ({ keys: route.keys, label: route.label, ...(route.pinned ? { pinned: true } : {}) }));
			paintShortcuts(frame, offsets.shortcuts, hints, this.theme);
		}
		(this.selection ?? this.selectionFlash)?.paint(frame);
		return this.surround(frame);
	}

}

/** Compact token totals for the header (13K / 1.0M style). */
export function formatTokens(total: number): string {
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
	if (total >= 1_000) return `${Math.round(total / 1_000)}K`;
	return String(total);
}
