import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import type { Agent as RuntimeAgent } from "../runtime/agent.ts";
import type { SessionAssembly } from "../configuration.ts";
import { fromSessionMessage, toSessionMessage } from "../event-projection.ts";
import { projectMessages, type SessionEntry, type SessionState } from "../session-storage.ts";
import { UsageTracker, estimateContextTokens } from "../usage.ts";
import type { ContextAssembler } from "./assembler.ts";
import { buildContext, type CompactionReason, type CompactionResult, type ContextSettings } from "./compaction.ts";
import { compactContext, type CompactionMetrics } from "./compact.ts";

interface CompactionHost {
	runtime: RuntimeAgent;
	usage: UsageTracker;
	assembler: ContextAssembler;
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
	budget() {
		const { options, driver } = this.host.configuration();
		return { window: options.contextWindow ?? options.model.contextWindow, output: driver.outputTokens?.(this.taskMaxTokens(), "inherit") ?? this.taskMaxTokens(), fixedText: options.systemPrompt + JSON.stringify(this.host.runtime.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))) };
	}
	syncUsage(): void {
		const { options } = this.host.configuration();
		const memory = this.host.assembler.projection.messages;
		this.host.usage.setContext({ messages: [...memory, ...projectMessages(this.host.runtime.state.messages.map(message => toSessionMessage(message)!))], contextWindow: options.contextWindow ?? options.model.contextWindow, identity: JSON.stringify([options.model, options.systemPrompt, options.thinkingLevel, options.tools, memory]), fixedText: this.budget().fixedText });
	}
	rebuild(): void {
		const { options } = this.host.configuration();
		this.host.runtime.state.messages = buildContext(this.host.history()).map(message => fromSessionMessage(message, options.model));
		this.host.usage.invalidate();
		this.syncUsage();
	}
	async run(reason: CompactionReason, signal: AbortSignal, emit: (event: SessionEvent) => void, instructions?: string): Promise<CompactionResult> {
		const { settings, driver } = this.host.configuration();
		const operationId = randomUUID();
		this.syncUsage();
		const beforeTokens = estimateContextTokens(projectMessages(this.host.runtime.state.messages.map(message => toSessionMessage(message)!))) + Math.ceil(this.budget().fixedText.length / 4);
		let compactionMetrics: CompactionMetrics | undefined;
		const event = (phase: "start" | "end" | "error" | "skipped", extra: { afterTokens?: number; error?: string; usage?: NonNullable<SessionMessage["usage"]> } = {}) => emit({ type: "compaction", phase, reason, operationId, beforeTokens, timestamp: Date.now(), ...compactionMetrics, ...extra });
		try {
			signal.throwIfAborted();
			event("start");
			const result = await compactContext(this.host.history(), settings, driver, this.budget(), beforeTokens, signal, details => {
				const changed = details.modelCalls !== (compactionMetrics?.modelCalls ?? 0);
				compactionMetrics = details;
				if (changed) emit({ type: "compaction", phase: "attempt", operationId, reason, beforeTokens, timestamp: Date.now(), ...details });
			}, instructions);
			signal.throwIfAborted();
			await this.host.persist(result.entry);
			this.rebuild();
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
