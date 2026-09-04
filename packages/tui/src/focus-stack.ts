import { Key, matchesKey } from "@earendil-works/pi-tui";

export interface FocusCard {
	id: string;
	/** Number of focusable controls inside this card. Defaults to one. */
	focusableCount?: number;
	shortcuts?: readonly string[];
}

export type FocusStackAction = "none" | "focus_next" | "focus_previous" | "park" | "resume" | "pop";

export interface FocusStackResult<T extends FocusCard> {
	action: FocusStackAction;
	card?: T;
	index: number;
}

/** A bounded focus owner for blocking cards. Tab never escapes the top card. */
export class FocusStack<T extends FocusCard = FocusCard> {
	private readonly stack: T[] = [];
	private readonly parked: T[] = [];
	private readonly dismissed: T[] = [];
	private index = 0;

	push(card: T): void {
		this.stack.push(card);
		this.index = 0;
	}

	pop(): T | undefined {
		const card = this.stack.pop();
		if (card) this.dismissed.push(card);
		this.index = 0;
		return card;
	}

	/** Move the focused card out of the key-owner stack without resolving it. */
	park(): T | undefined {
		const card = this.stack.pop();
		if (card) this.parked.push(card);
		this.index = 0;
		return card;
	}

	/** Return the most recently parked pending card to the focused stack. */
	resume(id?: string): T | undefined {
		const position = id === undefined ? this.parked.length - 1 : this.parked.findIndex((card) => card.id === id);
		if (position < 0) return undefined;
		const [card] = this.parked.splice(position, 1);
		if (!card) return undefined;
		this.stack.push(card);
		this.index = 0;
		return card;
	}

	/** Remove a card that reached a terminal outcome outside the focused card. */
	remove(id: string): T | undefined {
		const activePosition = this.stack.findIndex((card) => card.id === id);
		const parkedPosition = this.parked.findIndex((card) => card.id === id);
		if (activePosition < 0 && parkedPosition < 0) return undefined;
		const wasTop = activePosition === this.stack.length - 1;
		const [card] = activePosition >= 0 ? this.stack.splice(activePosition, 1) : this.parked.splice(parkedPosition, 1);
		if (!card) return undefined;
		this.dismissed.push(card);
		if (wasTop) this.index = 0;
		else {
			const count = normalizedFocusableCount(this.stack.at(-1)?.focusableCount);
			this.index = Math.min(this.index, count - 1);
		}
		return card;
	}

	top(): T | undefined {
		return this.stack.at(-1);
	}

	peek(): T | undefined {
		return this.top();
	}

	get size(): number {
		return this.stack.length;
	}

	get parkedSize(): number {
		return this.parked.length;
	}

	get focusIndex(): number {
		return this.index;
	}

	get active(): boolean {
		return this.stack.length > 0;
	}

	get hasParked(): boolean {
		return this.parked.length > 0;
	}

	parkedTop(): T | undefined {
		return this.parked.at(-1);
	}

	getParked(): readonly T[] {
		return this.parked.map((card) => ({ ...card }));
	}

	/** Cards popped by Esc remain available as transcript/scrollback records. */
	getScrollback(): readonly T[] {
		return [...this.dismissed, ...this.parked].map((card) => ({ ...card }));
	}

	shortcuts(): readonly string[] {
		return this.top()?.shortcuts ?? [];
	}

	handleInput(data: string): FocusStackResult<T> {
		const card = this.top();
		if (!card) {
			if (this.hasParked && (data === " " || matchesKey(data, Key.tab) || data === "\t")) {
				const resumed = this.resume();
				return resumed ? { action: "resume", card: resumed, index: 0 } : { action: "none", index: 0 };
			}
			return { action: "none", index: 0 };
		}
		if (matchesKey(data, Key.tab) || data === "\t") {
			const count = normalizedFocusableCount(card.focusableCount);
			this.index = (this.index + 1) % count;
			return { action: "focus_next", card, index: this.index };
		}
		if (matchesKey(data, "shift+tab")) {
			const count = normalizedFocusableCount(card.focusableCount);
			this.index = (this.index - 1 + count) % count;
			return { action: "focus_previous", card, index: this.index };
		}
		if (matchesKey(data, Key.escape) || data === "\u001b") {
			const parked = this.park();
			return parked ? { action: "park", card: parked, index: 0 } : { action: "park", index: 0 };
		}
		return { action: "none", card, index: this.index };
	}
}

function normalizedFocusableCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
	return Math.max(1, Math.floor(value));
}
