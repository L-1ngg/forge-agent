import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import type { SessionAssembly } from "../configuration.ts";
import { projectMessages, type SessionEntry, type SessionState } from "../session-storage.ts";
import { UsageTracker, calculateContextUsage } from "../usage.ts";
import { buildContext, type CompactionReason, type CompactionResult, type ContextSettings } from "./compaction.ts";
import { assertProtectedContextFits, compactContext, type CompactionBudget, type CompactionMetrics } from "./compact.ts";
import { requestFixedText } from "./request-budget.ts";

interface CompactionHost {
	messages(): SessionMessage[];
	tools(): NonNullable<SessionAssembly["options"]["tools"]>;
	usage: UsageTracker;
	configuration(): SessionAssembly & { settings: ContextSettings };
	history(): SessionState;
	persist(entry: SessionEntry): Promise<void>;
	isFaulted(): boolean;
}

/** Coordinates a committed context projection; trigger and retry policies stay in the session. */
export class CompactionCoordinator {
	constructor(private readonly host: CompactionHost) {}
	taskMaxTokens(): number {
		const { options } = this.host.configuration();
		return options.maxTokens ?? Math.min(4096, options.model.maxTokens || 4096);
	}
	budget(fixedText?: string): CompactionBudget {
		const { options, driver } = this.host.configuration();
		return { window: options.contextWindow ?? options.model.contextWindow, output: driver.outputTokens?.(this.taskMaxTokens(), "inherit") ?? this.taskMaxTokens(), fixedText: fixedText ?? requestFixedText({ systemPrompt: options.systemPrompt, tools: this.host.tools() }) };
	}
	syncUsage(budget = this.budget()): void {
		const { options } = this.host.configuration();
		this.host.usage.setContext({ messages: projectMessages(this.host.messages()), contextWindow: budget.window, identity: JSON.stringify([options.model, options.thinkingLevel, budget.output, budget.fixedText]), fixedText: budget.fixedText });
	}
	rebuild(budget?: CompactionBudget): void {
		buildContext(this.host.history()); // Validate the committed branch before publishing usage.
		this.host.usage.invalidate();
		this.syncUsage(budget);
	}
	async run(reason: CompactionReason, signal: AbortSignal, emit: (event: SessionEvent) => void, instructions?: string, requestBudget?: CompactionBudget): Promise<CompactionResult> {
		const { settings, driver } = this.host.configuration();
		const operationId = randomUUID();
		const budget = requestBudget ?? this.budget();
		this.syncUsage(budget);
		const beforeTokens = calculateContextUsage({ messages: projectMessages(this.host.messages()), fixedText: budget.fixedText }).contextTokens ?? 0;
		let compactionMetrics: CompactionMetrics | undefined;
		const event = (phase: "start" | "end" | "error" | "skipped", extra: { afterTokens?: number; error?: string; usage?: NonNullable<SessionMessage["usage"]> } = {}) => emit({ type: "compaction", phase, reason, operationId, beforeTokens, timestamp: Date.now(), ...compactionMetrics, ...extra });
		try {
			signal.throwIfAborted();
			event("start");
			if (reason === "threshold") assertProtectedContextFits(this.host.history(), budget, settings.reserveTokens);
			const result = await compactContext(this.host.history(), settings, driver, budget, beforeTokens, signal, details => {
				const changed = details.modelCalls !== (compactionMetrics?.modelCalls ?? 0);
				compactionMetrics = details;
				if (changed) emit({ type: "compaction", phase: "attempt", operationId, reason, beforeTokens, timestamp: Date.now(), ...details });
			}, instructions);
			signal.throwIfAborted();
			await this.host.persist(result.entry);
			this.rebuild(budget);
			const afterTokens = this.host.usage.snapshot().contextTokens ?? result.afterTokens;
			emit({ type: "compaction", phase: "end", operationId, reason, beforeTokens, afterTokens, timestamp: Date.now(), ...compactionMetrics });
			return { status: "complete", operationId, beforeTokens, afterTokens };
		} catch (error) {
			if (this.host.isFaulted()) throw error;
			const message = error instanceof Error ? error.message : String(error);
			event("error", { error: message });
			return { status: "error", operationId, beforeTokens, error: message };
		}
	}
}
