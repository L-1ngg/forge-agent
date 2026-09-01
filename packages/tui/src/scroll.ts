import { ScrollView, type Component } from "@earendil-works/pi-tui";

/** Application-owned transcript viewport used by both main and alt hosts. */
export class TranscriptScrollView extends ScrollView {
	constructor(component: Component) {
		super(component, { axis: "vertical", follow: "end", primary: true, overscroll: "contain", scrollbar: "auto" });
	}

	get offset(): number {
		return this.scrollTop;
	}

	scrollLines(lines: number): void {
		this.scrollBy(lines);
	}
}

export const ScrollTranscript = TranscriptScrollView;
