import { ScrollView, type Component } from "@earendil-works/pi-tui";

export interface TranscriptScrollViewOptions {
	/** Main-screen TUI has no layout pass, so clip the rendered child manually. */
	clipToViewport?: boolean;
	/** Exact top-level entry spans, used to retain the top visible entry across reflow. */
	entrySpans?: (width: number) => readonly TranscriptEntrySpan[];
}

export interface TranscriptEntrySpan {
	entryId: string;
	start: number;
	height: number;
	/** Entry-relative starts of width-stable logical lines. */
	logicalLineStarts?: readonly number[];
	/** Entry-relative final content row, excluding bottom padding. */
	lastContentRow?: number;
}

interface ScrollAnchor {
	entryId: string;
	rowWithinEntry: number;
	logicalLine?: number;
	subRows?: number;
}

/** Application-owned transcript viewport used by both main and alt hosts. */
export class TranscriptScrollView extends ScrollView {
	private readonly clipToViewport: boolean;
	private readonly entrySpans: ((width: number) => readonly TranscriptEntrySpan[]) | undefined;
	private viewportHeightOverride: number | undefined;
	private previousEntrySpans: readonly TranscriptEntrySpan[] = [];

	constructor(component: Component, options: TranscriptScrollViewOptions = {}) {
		super(component, { axis: "vertical", follow: "end", primary: true, overscroll: "contain", scrollbar: "auto" });
		this.clipToViewport = options.clipToViewport ?? false;
		this.entrySpans = options.entrySpans;
	}

	get offset(): number {
		return this.scrollTop;
	}

	scrollLines(lines: number): void {
		this.scrollBy(lines);
	}

	/** Set the regular-host viewport height; alt-screen supplies it via layout. */
	setViewportHeight(height: number | undefined): void {
		this.viewportHeightOverride = height === undefined ? undefined : Math.max(0, Math.floor(height));
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.clipToViewport || this.viewportHeightOverride === undefined) return lines;
		const viewportHeight = this.viewportHeightOverride;
		const previousAnchor = !this.isFollowingEnd ? this.captureAnchor(this.scrollTop) : undefined;
		this.updateLayout(lines.length, viewportHeight, () => undefined);
		const spans = [...(this.entrySpans?.(width) ?? [])];
		if (!this.isFollowingEnd && previousAnchor) {
			const span = spans.find((value) => value.entryId === previousAnchor.entryId);
			if (span) this.scrollTo(span.start + this.restoreRow(span, previousAnchor), { disableFollow: true });
		}
		this.previousEntrySpans = spans;
		return lines.slice(this.scrollTop, this.scrollTop + viewportHeight);
	}

	private captureAnchor(scrollTop: number): ScrollAnchor | undefined {
		const containing = this.previousEntrySpans.find((span) => scrollTop >= span.start && scrollTop < span.start + span.height);
		if (containing) return this.anchorWithinSpan(containing, scrollTop - containing.start);
		const preceding = [...this.previousEntrySpans].reverse().find((span) => span.start <= scrollTop);
		return preceding === undefined ? undefined : this.anchorWithinSpan(preceding, Math.max(0, scrollTop - preceding.start));
	}

	private anchorWithinSpan(span: TranscriptEntrySpan, rowWithinEntry: number): ScrollAnchor {
		const starts = span.logicalLineStarts ?? [];
		if (starts.length === 0) return { entryId: span.entryId, rowWithinEntry };
		let logicalLine = 0;
		while (logicalLine + 1 < starts.length && (starts[logicalLine + 1] ?? Number.POSITIVE_INFINITY) <= rowWithinEntry) logicalLine++;
		return {
			entryId: span.entryId,
			rowWithinEntry,
			logicalLine,
			subRows: rowWithinEntry - (starts[logicalLine] ?? 0),
		};
	}

	private restoreRow(span: TranscriptEntrySpan, anchor: ScrollAnchor): number {
		const maxEntryRow = Math.max(0, span.height - 1);
		const starts = span.logicalLineStarts ?? [];
		if (anchor.logicalLine === undefined || anchor.subRows === undefined || starts.length === 0) {
			return Math.min(anchor.rowWithinEntry, maxEntryRow);
		}
		const logicalLine = Math.min(anchor.logicalLine, starts.length - 1);
		const lineStart = starts[logicalLine] ?? 0;
		const lineEnd = Math.min(
			maxEntryRow,
			starts[logicalLine + 1] === undefined
				? span.lastContentRow ?? maxEntryRow
				: Math.max(lineStart, (starts[logicalLine + 1] ?? lineStart + 1) - 1),
		);
		return Math.max(0, Math.min(lineEnd, lineStart + anchor.subRows));
	}
}

export const ScrollTranscript = TranscriptScrollView;
