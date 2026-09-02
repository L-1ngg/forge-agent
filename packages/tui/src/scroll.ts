import { ScrollView, type Component } from "@earendil-works/pi-tui";

export interface TranscriptScrollViewOptions {
	/** Main-screen TUI has no layout pass, so clip the rendered child manually. */
	clipToViewport?: boolean;
}

/** Application-owned transcript viewport used by both main and alt hosts. */
export class TranscriptScrollView extends ScrollView {
	private readonly clipToViewport: boolean;
	private viewportHeightOverride: number | undefined;

	constructor(component: Component, options: TranscriptScrollViewOptions = {}) {
		super(component, { axis: "vertical", follow: "end", primary: true, overscroll: "contain", scrollbar: "auto" });
		this.clipToViewport = options.clipToViewport ?? false;
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
		this.updateLayout(lines.length, viewportHeight, () => undefined);
		return lines.slice(this.scrollTop, this.scrollTop + viewportHeight);
	}
}

export const ScrollTranscript = TranscriptScrollView;
