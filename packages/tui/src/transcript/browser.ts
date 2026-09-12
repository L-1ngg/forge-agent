import { defaultStyle, writeText, type TerminalFrame } from "../frame.ts";
import { ScrollState, type EntrySpan } from "../scroll.ts";
import type { Theme } from "../theme.ts";
import { entryHeight, paintEntry } from "./entry-shell.ts";
import { transcriptViews, type TranscriptView } from "./groups.ts";
import { TranscriptProjector } from "./projector.ts";
import type { TranscriptEntry } from "./types.ts";

/** Main transcript browsing: one layout for navigation, hit testing and painting. */
export class TranscriptBrowser {
	private readonly scroll = new ScrollState();
	private readonly expandedGroups = new Set<string>();
	private selectedId: string | undefined;
	private lastClick: { id: string; at: number } | undefined;
	private views: TranscriptView[] = [];
	private spans: EntrySpan[] = [];
	private totalRows = 0;
	private columns = 0;
	private height = 0;
	private previous: { spans: EntrySpan[]; totalRows: number; height: number } | undefined;

	constructor(private readonly projector: TranscriptProjector, private readonly theme: Theme) { }

	get selectedEntry(): TranscriptEntry | undefined { return this.selectedId ? this.projector.getEntry(this.selectedId) : undefined; }
	get canView(): boolean { return this.isGroup || this.selectedEntry !== undefined; }
	get canFold(): boolean {
		const entry = this.selectedEntry;
		return this.isGroup || !!entry && ["tool", "thinking", "execute", "edit"].includes(entry.kind);
	}
	private get isGroup(): boolean { return this.selectedId?.startsWith("group:") ?? false; }
	private get windowTop(): number { return Math.max(0, this.totalRows - this.height - this.scroll.offset); }

	/** Reconcile new transcript content or viewport dimensions before consuming the layout. */
	update(columns: number, height: number): void {
		this.columns = columns; this.height = height;
		this.views = transcriptViews(this.projector.getEntries(), columns, this.theme, this.expandedGroups);
		for (const view of this.views) {
			if (view.members?.some(member => this.expandedGroups.has(member.id))) {
				for (const member of view.members) this.expandedGroups.add(member.id);
			}
		}
		if (this.selectedId && !this.views.some(view => view.id === this.selectedId)) {
			const memberId = this.isGroup ? this.selectedId.slice(6) : this.selectedId;
			this.selectedId = this.views.find(view => view.id === memberId || view.members?.some(member => member.id === memberId))?.id;
		}
		let start = 0;
		this.spans = this.views.map(view => {
			const span = { entryId: view.id, start, height: entryHeight(view.presentation), rowSources: [
				...Array.from({ length: view.presentation.chrome.vpadTop }, () => undefined),
				...view.presentation.rows.map(row => row.source),
			] };
			start += span.height;
			return span;
		});
		this.totalRows = start;
		// A hidden transcript must not replace the last visible reading anchor.
		if (height <= 0) return;
		if (this.previous) this.scroll.captureAnchor(this.previous.spans, this.previous.totalRows, this.previous.height);
		this.scroll.restoreAnchor(this.spans, this.totalRows, height);
		this.previous = { spans: this.spans, totalRows: this.totalRows, height };
		const maxOffset = Math.max(0, this.totalRows - height);
		if (this.scroll.offset > maxOffset) this.scroll.scrollBy(0, maxOffset);
	}

	enter(): void { this.selectedId ??= this.views.at(-1)?.id; }
	moveSelection(delta: number): void {
		const current = this.views.findIndex(view => view.id === this.selectedId);
		this.selectedId = this.views[Math.max(0, Math.min(this.views.length - 1, current + delta))]?.id;
		const span = this.spans.find(item => item.entryId === this.selectedId);
		if (span && (span.start < this.windowTop || span.start >= this.windowTop + this.height)) this.setTop(span.start);
	}

	scrollBy(lines: number): void {
		this.scroll.scrollBy(lines, Math.max(0, this.totalRows - this.height));
		this.scroll.hold();
	}
	scrollPage(direction: 1 | -1): void { this.scrollBy(direction * Math.max(1, this.height - 1)); }
	jumpToEnd(): void { this.scroll.jumpToEnd(); }
	private setTop(top: number): void {
		const max = Math.max(0, this.totalRows - this.height);
		this.scroll.scrollBy(max - top - this.scroll.offset, max);
		this.scroll.hold();
		// This layout already includes the fold. The next update anchors from here,
		// even when several navigation actions happen before the next paint.
		this.previous = { spans: this.spans, totalRows: this.totalRows, height: this.height };
	}

	fold(mode?: "collapsed" | "expanded"): void {
		const top = this.windowTop;
		if (this.isGroup) {
			const members = this.views.find(view => view.id === this.selectedId)?.members ?? [];
			const close = mode === "collapsed" || mode === undefined && members.some(member => this.expandedGroups.has(member.id));
			for (const member of members) {
				if (close) this.expandedGroups.delete(member.id);
				else this.expandedGroups.add(member.id);
			}
			this.update(this.columns, this.height);
			this.setTop(top);
			return;
		}
		const entry = this.selectedEntry;
		if (!entry || (entry.kind !== "tool" && entry.kind !== "thinking" && entry.kind !== "execute" && entry.kind !== "edit")) return;
		const current = entry.kind === "tool" ? entry.displayMode : entry.block.currentDisplayMode ?? entry.block.defaultDisplayMode ?? entry.block.fold.defaultDisplayMode ?? "expanded";
		const next = mode ?? (current === "collapsed" ? entry.kind === "tool" && entry.name === "read" ? "truncated" : "expanded" : "collapsed");
		const previousStart = this.spans.find(span => span.entryId === entry.id)?.start ?? 0;
		this.projector.setEntryDisplayState(entry.id, next, true);
		this.update(this.columns, this.height);
		const nextStart = this.spans.find(span => span.entryId === entry.id)?.start ?? previousStart;
		this.setTop(top + nextStart - previousStart);
	}

	/** Enter on a group reveals its first member; Enter on a member opens details. */
	openDetail(): TranscriptEntry | undefined {
		this.scroll.hold();
		const members = this.views.find(view => view.id === this.selectedId)?.members;
		if (members) {
			for (const member of members) this.expandedGroups.add(member.id);
			this.selectedId = members[0]?.id;
			this.update(this.columns, this.height);
			return undefined;
		}
		return this.selectedEntry;
	}

	/** Row is relative to the transcript viewport. Double-clicking a header folds once. */
	click(row: number, at: number): { selectText: boolean } | undefined {
		if (row < 0 || row >= this.height) return;
		const targetRow = this.windowTop + row;
		const span = this.spans.find(candidate => candidate.start <= targetRow && targetRow < candidate.start + candidate.height);
		if (!span) return;
		this.selectedId = span.entryId;
		this.scroll.hold();
		if (span.start === targetRow && this.lastClick?.id === span.entryId && at - this.lastClick.at <= 400) {
			this.fold(); this.lastClick = undefined;
		} else this.lastClick = span.start === targetRow ? { id: span.entryId, at } : undefined;
		const source = this.projector.getEntry(span.entryId);
		return { selectText: targetRow > span.start || source?.kind === "assistant" || source?.kind === "user" || source?.kind === "notice" };
	}
	cancelClick(): void { this.lastClick = undefined; }

	reset(): void {
		this.selectedId = undefined; this.expandedGroups.clear(); this.scroll.jumpToEnd();
		this.previous = undefined; this.lastClick = undefined;
		this.views = []; this.spans = []; this.totalRows = 0;
	}

	/** Paint the reconciled layout without changing browsing state. */
	paint(frame: TerminalFrame, top: number, focused: boolean): void {
		const height = this.height;
		if (height <= 0) return;
		const presentations = this.views, spans = this.spans, windowTop = this.windowTop;
		for (const [index, span] of spans.entries()) {
			if (span.start + span.height <= windowTop || span.start >= windowTop + height) continue;
			paintEntry(frame, top + (span.start - windowTop), presentations[index]!.presentation, this.theme, { top, bottom: top + height });
			if (focused && span.entryId === this.selectedId) {
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
		const selected = focused ? presentations.findIndex((view) => view.id === this.selectedId) : -1;
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

}
