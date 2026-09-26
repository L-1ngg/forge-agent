import { freeze, cancellable } from "./host-callback.ts";
import type { SessionMessage, TokenUsage } from "@forge-agent/protocol";
import type { Model } from "./session-port.ts";

type Snapshot<T> = T extends object ? { readonly [K in keyof T]: Snapshot<T[K]> } : T;

/** Totals for this invocation, including task retries and automatic summaries. */
export interface InvocationUsage {
	readonly requests: number;
	/** null if any request has missing, invalid, or all-zero placeholder usage. */
	readonly tokens: Readonly<Omit<TokenUsage, "cost">> | null;
	/** Reported USD cost; null if any request has unknown usage or cost. */
	readonly costUsd: number | null;
	readonly missingUsageRequests: number;
	readonly missingCostRequests: number;
}

export interface ShouldStopAfterTurnContext {
	readonly message: Snapshot<SessionMessage>;
	readonly toolResults: readonly Snapshot<SessionMessage>[];
	/** Model and applied revision used by the completed task request. */
	readonly model: Snapshot<Model<string>>;
	readonly configurationRevision: number;
	/** One-based completed rounds within this runTurn/continue invocation. */
	readonly turnIndex: number;
	readonly usage: InvocationUsage;
}

/** Runs after a persisted batch, before more input or model requests. Errors fail the invocation without retry. */
export type ShouldStopAfterTurn = (context: ShouldStopAfterTurnContext, signal: AbortSignal) => boolean | Promise<boolean>;

/** Invocation-local accounting and policy settlement; no runtime state is exposed to hosts. */
export class TurnPolicy {
	stopped = false;
	failed = false;
	private turnIndex = 0;
	private requests = 0;
	private missingUsageRequests = 0;
	private missingCostRequests = 0;
	private costUsd = 0;
	private tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

	constructor(private readonly callback: ShouldStopAfterTurn) {}

	beginRequest(): (usage?: TokenUsage) => void {
		this.requests++; this.missingUsageRequests++; this.missingCostRequests++;
		let settled = false;
		return usage => {
			if (settled) return;
			settled = true;
			const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
			if (!usage || !fields.every(key => Number.isFinite(usage[key]) && usage[key] >= 0) || usage.totalTokens === 0) return;
			this.missingUsageRequests--;
			for (const key of fields) this.tokens[key] += usage[key];
			const cost = usage.cost?.total;
			if (cost !== undefined && Number.isFinite(cost) && cost >= 0) { this.missingCostRequests--; this.costUsd += cost; }
		};
	}

	async evaluate(completed: Omit<ShouldStopAfterTurnContext, "turnIndex" | "usage">, signal: AbortSignal): Promise<boolean> {
		try {
			signal.throwIfAborted();
			const context = freeze(structuredClone({ ...completed, turnIndex: ++this.turnIndex, usage: {
				requests: this.requests,
				tokens: this.missingUsageRequests ? null : { ...this.tokens },
				costUsd: this.missingCostRequests ? null : this.costUsd,
				missingUsageRequests: this.missingUsageRequests, missingCostRequests: this.missingCostRequests,
			} }));
			const stop = await cancellable(() => this.callback(context, signal), signal);
			signal.throwIfAborted();
			if (typeof stop !== "boolean") throw new TypeError("Expected a boolean return value");
			this.stopped = stop;
			return stop;
		} catch (error) {
			signal.throwIfAborted();
			this.failed = true;
			throw new Error(`shouldStopAfterTurn failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
}
