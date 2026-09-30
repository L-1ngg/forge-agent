import type { SessionEvent, SessionMessage, TurnResult } from "@forge-agent/protocol";
import type { InputAcceptance } from "./agent.ts";
import type { TurnPolicy } from "./turn-policy.ts";

/** Process-local input ownership and settlement for one consumed AgentTurn. */
export class SessionInvocation {
	readonly controller = new AbortController();
	readonly settled: Promise<void>;
	iterator!: AsyncIterator<SessionEvent>;
	begun = false;
	private closed = false;
	private accepting = true;
	private readonly steering: SessionMessage[] = [];
	private readonly followups: SessionMessage[] = [];
	private readonly receipts = new Map<SessionMessage, (processed: boolean) => void>();
	private resolveIdle!: () => void;
	private failures = 0;
	private recovered = false;
	outcome: TurnResult | undefined;
	constructor(readonly id: symbol, readonly policy: TurnPolicy | undefined, private readonly resolveResult: (result: TurnResult) => void, private readonly release: () => void) {
		this.settled = new Promise(resolve => { this.resolveIdle = resolve; });
	}
	get canceled(): boolean { return this.controller.signal.aborted; }
	finish(status?: TurnResult["status"]): void {
		if (this.closed) return;
		this.closed = true; this.closeInput(); this.release();
		this.resolveResult(status ? { status } : this.outcome ?? { status: "aborted" }); this.resolveIdle();
	}
	consume(source: AsyncIterator<SessionEvent>, abort: () => void): AsyncIterator<SessionEvent> {
		this.iterator = source;
		return {
			next: async () => {
				if (this.closed) return { done: true, value: undefined };
				if (this.canceled && !this.begun) { this.finish("aborted"); return { done: true, value: undefined }; }
				this.begun = true;
				try { const next = await source.next(); if (next.done) this.finish(); return next; }
				catch (error) { this.finish("error"); throw error; }
			},
			return: async () => {
				if (this.closed) return { done: true, value: undefined };
				abort();
				try { return await source.return?.() ?? { done: true, value: undefined }; }
				catch (error) { this.finish("error"); throw error; }
				finally { this.finish(); }
			},
		};
	}
	enqueue(message: SessionMessage, mode: "steer" | "followUp", id: symbol): InputAcceptance {
		if (!this.accepting || !this.begun || this.canceled || this.id !== id) return { accepted: false };
		const processed = new Promise<boolean>(resolve => { this.receipts.set(message, resolve); });
		(mode === "steer" ? this.steering : this.followups).push(message);
		return { accepted: true, processed };
	}
	drain(mode: "steer" | "followUp", strategy = "all"): SessionMessage[] {
		const queue = mode === "steer" ? this.steering : this.followups;
		return queue.splice(0, strategy === "one-at-a-time" ? 1 : queue.length);
	}
	acknowledge(message: SessionMessage, processed: boolean): void { this.receipts.get(message)?.(processed); this.receipts.delete(message); }
	closeInput(): void {
		this.accepting = false; this.steering.length = 0; this.followups.length = 0;
		for (const resolve of this.receipts.values()) resolve(false);
		this.receipts.clear();
	}
	cancel(): void { this.controller.abort(); this.closeInput(); }
	resetRecovery(): void { this.recovered = false; }
	resetFailures(): void { this.failures = 0; this.resetRecovery(); }
	claimRecovery(): boolean { if (this.recovered) return false; this.recovered = true; return true; }
	nextRetry(maxRetries: number): number | undefined { return this.failures < maxRetries ? ++this.failures : undefined; }
	result(reason: SessionMessage["stopReason"], failed: boolean): TurnResult {
		const status = failed ? "error" : this.canceled ? "aborted" : this.policy?.failed ? "error" : reason === "error" || reason === "aborted" || reason === "length" || reason === "deferred" ? reason : "success";
		return { status, ...(status === "success" && this.policy?.stopped ? { terminationReason: "policy" as const } : {}) };
	}
}
