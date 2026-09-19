import type { SessionEvent, TurnResult } from "@forge-agent/protocol";

export interface InputDecision { next?: string; restore: string[]; }

/** Host-owned drafts and continuation intent; SDK receipts never become a mailbox. */
export class InputFlow {
	private readonly queued: string[] = [];
	private replacement: string | undefined;
	private paused = false;
	private current: { input: string; processed: boolean } | undefined;

	get isPaused(): boolean { return this.paused; }
	get queuedCount(): number { return this.queued.length; }
	get hasPending(): boolean { return this.queued.length > 0 || this.replacement !== undefined; }
	labels(): string[] {
		return [...this.queued.map((input, index) => `Queued ${index + 1}: ${input}`), ...(this.replacement !== undefined ? [`Next: ${this.replacement}`] : [])];
	}
	enqueue(input: string): void { this.queued.push(input); }
	recall(): string | undefined { return this.queued.pop(); }
	start(): void { this.paused = false; }
	begin(input: string): void { this.current = { input, processed: false }; }
	observe(event: SessionEvent): void {
		if (this.current && (event.type === "message_start" || event.type === "message_end") && event.message.role === "user") this.current.processed = true;
	}
	stopAndSend(input: string | undefined): void {
		this.paused = true;
		if (this.replacement !== undefined) this.queued.push(this.replacement);
		this.replacement = input;
	}
	pause(): string[] {
		this.paused = true;
		if (this.replacement !== undefined) this.queued.push(this.replacement);
		this.replacement = undefined;
		return this.queued.splice(0);
	}
	settle(status: TurnResult["status"] | undefined, failed: boolean, switching: boolean): InputDecision {
		const interrupted = failed || switching || status === "error" || status === "aborted";
		if (interrupted && this.current && !this.current.processed) this.queued.unshift(this.current.input);
		this.current = undefined;
		if (failed || switching || status === "error" || (status === "aborted" && !this.paused)) {
			return { restore: this.pause() };
		}
		if (this.paused) {
			const restore = this.queued.splice(0);
			const next = this.replacement;
			this.replacement = undefined;
			this.paused = false;
			return { restore, ...(next !== undefined ? { next } : {}) };
		}
		const next = this.takeNext();
		return { restore: [], ...(next !== undefined ? { next } : {}) };
	}
	takeNext(): string | undefined { return this.paused ? undefined : this.queued.shift(); }
	reset(): void { this.queued.length = 0; this.replacement = undefined; this.current = undefined; this.paused = true; }
}
