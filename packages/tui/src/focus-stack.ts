import { Key, matchesKey } from "@earendil-works/pi-tui";

export interface FocusCard {
	id: string;
	/** Number of focusable controls inside this card. Defaults to one. */
	focusableCount?: number;
	shortcuts?: readonly string[];
}

export type FocusStackAction = "none" | "focus_next" | "focus_previous" | "pop";

export interface FocusStackResult<T extends FocusCard> {
	action: FocusStackAction;
	card?: T;
	index: number;
}

/** A bounded focus owner for blocking cards. Tab never escapes the top card. */
export class FocusStack<T extends FocusCard = FocusCard> {
	private readonly stack: T[] = [];
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

	top(): T | undefined {
		return this.stack.at(-1);
	}

	peek(): T | undefined {
		return this.top();
	}

	get size(): number {
		return this.stack.length;
	}

	get focusIndex(): number {
		return this.index;
	}

	get active(): boolean {
		return this.stack.length > 0;
	}

	/** Cards popped by Esc remain available as transcript/scrollback records. */
	getScrollback(): readonly T[] {
		return this.dismissed.map((card) => ({ ...card }));
	}

	shortcuts(): readonly string[] {
		return this.top()?.shortcuts ?? [];
	}

	handleInput(data: string): FocusStackResult<T> {
		const card = this.top();
		if (!card) return { action: "none", index: 0 };
		if (matchesKey(data, Key.tab) || data === "\t") {
			const count = Math.max(1, Math.floor(card.focusableCount ?? 1));
			this.index = (this.index + 1) % count;
			return { action: "focus_next", card, index: this.index };
		}
		if (matchesKey(data, "shift+tab")) {
			const count = Math.max(1, Math.floor(card.focusableCount ?? 1));
			this.index = (this.index - 1 + count) % count;
			return { action: "focus_previous", card, index: this.index };
		}
		if (matchesKey(data, Key.escape) || data === "\u001b") {
			const popped = this.pop();
			return popped ? { action: "pop", card: popped, index: 0 } : { action: "pop", index: 0 };
		}
		return { action: "none", card, index: this.index };
	}
}
