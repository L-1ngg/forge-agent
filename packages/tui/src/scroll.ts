/**
 * Application-level transcript scroll state (phase 2.2 B3).
 * offsetFromBottom === 0 means follow mode: new content keeps the viewport
 * pinned to the end. Once the user scrolls up, an entry-level anchor keeps
 * the same content in view across reflow/resize.
 */
export interface EntrySpan {
	entryId: string;
	start: number;
	height: number;
}

export interface ScrollAnchor {
	entryId: string;
	rowWithinEntry: number;
}

export class ScrollState {
	private offsetFromBottom = 0;
	private anchor: ScrollAnchor | undefined;

	get following(): boolean {
		return this.offsetFromBottom === 0;
	}

	get offset(): number {
		return this.offsetFromBottom;
	}

	scrollBy(lines: number, maxOffset: number): void {
		this.offsetFromBottom = clamp(this.offsetFromBottom + Math.trunc(lines), 0, Math.max(0, maxOffset));
		if (this.offsetFromBottom === 0) this.anchor = undefined;
	}

	pageBy(pages: number, viewportHeight: number, maxOffset: number): void {
		this.scrollBy(pages * Math.max(1, viewportHeight - 1), maxOffset);
	}

	jumpToEnd(): void {
		this.offsetFromBottom = 0;
		this.anchor = undefined;
	}

	/** Capture the entry under the viewport's top row before a reflow. */
	captureAnchor(spans: readonly EntrySpan[], totalRows: number, viewportHeight: number): void {
		if (this.following) return;
		const viewportTop = Math.max(0, totalRows - this.offsetFromBottom - viewportHeight);
		const span = spans.find((candidate) => viewportTop >= candidate.start && viewportTop < candidate.start + candidate.height)
			?? [...spans].reverse().find((candidate) => candidate.start <= viewportTop);
		if (!span) return;
		this.anchor = { entryId: span.entryId, rowWithinEntry: Math.max(0, viewportTop - span.start) };
	}

	/** After a reflow, reposition so the anchored entry row stays put. */
	restoreAnchor(spans: readonly EntrySpan[], totalRows: number, viewportHeight: number): void {
		if (this.following || !this.anchor) return;
		const span = spans.find((candidate) => candidate.entryId === this.anchor!.entryId);
		if (!span) {
			this.anchor = undefined;
			return;
		}
		const row = Math.min(span.start + this.anchor.rowWithinEntry, span.start + Math.max(0, span.height - 1));
		const maxOffset = Math.max(0, totalRows - viewportHeight);
		this.offsetFromBottom = clamp(totalRows - viewportHeight - (row - 0), 0, maxOffset);
		// Anchor consumed; recapture on the next reflow.
		this.anchor = undefined;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
