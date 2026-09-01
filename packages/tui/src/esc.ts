export type EscAction = "abort" | "pop" | "rewind" | "arm" | "noop";

export interface EscControllerOptions {
	doublePressMs?: number;
	suppressRewindMs?: number;
	now?: () => number;
}

/** Small, deterministic Esc state machine shared by App and card hosts. */
export class EscController {
	private readonly doublePressMs: number;
	private readonly suppressRewindMs: number;
	private readonly now: () => number;
	private lastEscAt = -Infinity;
	private suppressUntil = -Infinity;

	constructor(options: EscControllerOptions = {}) {
		this.doublePressMs = options.doublePressMs ?? 800;
		this.suppressRewindMs = options.suppressRewindMs ?? 1_000;
		this.now = options.now ?? Date.now;
	}

	press(options: { hasFocusedCard?: boolean; running?: boolean } = {}): EscAction {
		const timestamp = this.now();
		if (options.hasFocusedCard) {
			this.lastEscAt = -Infinity;
			return "pop";
		}
		if (options.running) {
			this.lastEscAt = -Infinity;
			this.suppressUntil = timestamp + this.suppressRewindMs;
			return "abort";
		}
		if (timestamp <= this.suppressUntil) {
			// A suppressed press must not become the first half of a later rewind.
			this.lastEscAt = -Infinity;
			return "noop";
		}
		if (timestamp - this.lastEscAt <= this.doublePressMs) {
			this.lastEscAt = -Infinity;
			return "rewind";
		}
		this.lastEscAt = timestamp;
		return "arm";
	}

	markCancelled(): void {
		this.suppressUntil = this.now() + this.suppressRewindMs;
		this.lastEscAt = -Infinity;
	}

	/** Clear an idle double-press candidate when a higher-priority layer owns input. */
	reset(): void {
		this.lastEscAt = -Infinity;
	}
}
