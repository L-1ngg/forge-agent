import type { TerminalFrame } from "./frame.ts";

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
		const lines: string[] = [];
		for (let y = start.y; y <= end.y; y++) {
			const left = y === start.y ? start.x : this.bounds.left;
			const right = y === end.y ? end.x + 1 : this.bounds.right;
			lines.push(this.snapshot.cells[y]?.slice(left, right).map((cell) => cell.grapheme).join("").trimEnd() ?? "");
		}
		return lines.join("\n");
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
