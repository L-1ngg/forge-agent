import type { SourceDocument, TerminalFrame } from "./frame.ts";

interface Point { x: number; y: number }

/** A drag selects the displayed text snapshot, so streamed updates cannot change the copied text. */
export class TextSelection {
	private end: Point;
	constructor(private readonly start: Point, private readonly snapshot: TerminalFrame, private readonly bounds: { top: number; bottom: number; left: number; right: number }) {
		this.end = start;
	}

	move(point: Point): void {
		this.end = { x: Math.max(this.bounds.left, Math.min(this.bounds.right - 1, point.x)), y: Math.max(this.bounds.top, Math.min(this.bounds.bottom - 1, point.y)) };
	}

	get moved(): boolean { return this.start.x !== this.end.x || this.start.y !== this.end.y; }

	private range(): [Point, Point] {
		return this.start.y < this.end.y || (this.start.y === this.end.y && this.start.x <= this.end.x) ? [this.start, this.end] : [this.end, this.start];
	}

	text(): string {
		if (!this.moved) return "";
		const [start, end] = this.range();
		const parts: { document?: SourceDocument; start: number; end: number; text: string }[] = [];
		for (let y = start.y; y <= end.y; y++) {
			const left = y === start.y ? start.x : this.bounds.left;
			const right = y === end.y ? end.x + 1 : this.bounds.right;
			const cells = this.snapshot.cells[y]?.slice(left, right) ?? [];
			const mapped = cells.filter(cell => cell.source);
			if (mapped.length) {
				for (const cell of mapped) {
					const source = cell.source!;
					const from = source.copyStart ?? source.start, to = source.copyEnd ?? source.end;
					const last = parts.at(-1);
					if (last?.document === source.document) { last.start = Math.min(last.start, from); last.end = Math.max(last.end, to); }
					else parts.push({ document: source.document, start: from, end: to, text: "" });
				}
			} else {
				const text = cells.map(cell => cell.grapheme).join("").trimEnd();
				if (text || !parts.at(-1)?.document) parts.push({ start: 0, end: 0, text });
			}
		}
		return parts.map(part => part.document ? part.document.text.slice(part.start, part.end) : part.text).join("\n");
	}

	paint(frame: TerminalFrame): void {
		if (!this.moved) return;
		const [start, end] = this.range();
		for (let y = start.y; y <= end.y; y++) {
			for (let x = y === start.y ? start.x : this.bounds.left; x <= (y === end.y ? end.x : this.bounds.right - 1); x++) {
				const cell = frame.cells[y]?.[x];
				if (cell) cell.attributes = { ...cell.attributes, inverse: true };
			}
		}
	}
}
