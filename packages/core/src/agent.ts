import type { RequestEnvelopeUnion, ResponseEnvelope, SessionEvent } from "@forge-agent/protocol";
import type { HarnessTool, ToolInputRewrite } from "@forge-agent/tools";
import { AgentRunner, type AgentPort, type InputAcceptance } from "./agent-runner.ts";
import { createPiPort, type PiPortOptions } from "./pi-port.ts";
import { MemoryPermissionStore, type PermissionContext } from "./permission/index.ts";
import { RequestBus } from "./request-bus.ts";
import { MemorySessionStorage, sessionMessages, type SessionStorage } from "./session-storage.ts";
import type { UsageTruthPoint } from "./usage.ts";
import { resolveRetryPolicy, validateRequestLimits, type CompactionResult, type ContextSettings, type RetryPolicy } from "./context/compaction.ts";
import { randomUUID } from "node:crypto";

export interface CreateAgentOptions {
	/** Shared task/summary routing identity; supply it to retain affinity across reopening. */
	sessionId?: string;
	context?: Partial<ContextSettings>;
	retry?: Partial<RetryPolicy>;
	maxTokens?: number;
	contextWindow?: number;
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
	systemPrompt: string;
	cwd: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: HarnessTool<object, unknown>[];
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	permission?: PermissionContext;
	storage?: SessionStorage;
	requestBus?: RequestBus;
}

export interface AgentTurn extends AsyncIterable<SessionEvent> {
	readonly id: symbol;
}

export interface Agent extends Omit<AgentPort, "runTurn" | "steer" | "followUp"> {
	compact(instructions?: string, emit?: (event: SessionEvent) => void): Promise<CompactionResult>;
	configureContext(settings: Partial<ContextSettings>): void;
	runTurn(input: string): AgentTurn;
	steer(input: string, expectedTurnId: symbol): InputAcceptance;
	followUp(input: string, expectedTurnId: symbol): InputAcceptance;
	readonly requests: AsyncIterable<RequestEnvelopeUnion>;
	getUsage(): UsageTruthPoint | undefined;
	respond(response: ResponseEnvelope): boolean;
	dispose(): Promise<void>;
}

export type AgentOptions = CreateAgentOptions;

export async function createAgent(options: CreateAgentOptions, portFactory: (options: PiPortOptions) => AgentPort | Promise<AgentPort> = createPiPort): Promise<Agent> {
	resolveRetryPolicy(options.retry);
	validateRequestLimits(options);
	const storage = options.storage ?? new MemorySessionStorage();
	const requestBus = options.requestBus ?? new RequestBus();
	try {
		const history = await storage.load();
		const port = await portFactory({
			sessionId: options.sessionId ?? randomUUID(),
			provider: options.provider,
			model: options.model,
			systemPrompt: options.systemPrompt,
			cwd: options.cwd,
			thinkingLevel: options.thinkingLevel ?? "off",
			...(options.context ? { context: options.context } : {}),
			...(options.retry ? { retry: options.retry } : {}),
			...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
			...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
			...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
			...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
			...(options.tools ? { tools: options.tools } : {}),
			...(options.toolInputRewrites ? { toolInputRewrites: options.toolInputRewrites } : {}),
			permission: { ...options.permission, memory: options.permission?.memory ?? new MemoryPermissionStore() },
			requestBus,
			history: sessionMessages(history),
		});
		return new HostedAgent(new AgentRunner(port, storage, requestBus), requestBus);
	} catch (error) {
		if (!options.requestBus) requestBus.close();
		throw error;
	}
}

class HostedAgent implements Agent {
	readonly requests: AsyncIterable<RequestEnvelopeUnion>;
	private active: { id: symbol; iterator: AsyncIterator<SessionEvent>; begun: boolean; canceled: boolean } | undefined;
	private disposed = false;
	private faulted = false;
	private disposing: Promise<void> | undefined;
	private compacting: Promise<CompactionResult> | undefined;
	private compactController: AbortController | undefined;

	constructor(private runner: AgentRunner | undefined, private readonly bus: RequestBus) {
		this.requests = bus.requests();
	}

	runTurn(input: string): AgentTurn {
		this.assertAvailable();
		if (this.compacting) throw new Error("Agent is compacting");
		let started = false;
		const id = Symbol("invocation");
		return {
			id,
			[Symbol.asyncIterator]: () => {
				this.assertAvailable();
				if (this.compacting) throw new Error("Agent is compacting");
				if (started) throw new Error("A turn can only be consumed once");
				if (this.active) throw new Error("Agent is already processing a turn");
				started = true;
				const iterator = this.runner!.runTurn(input)[Symbol.asyncIterator]();
				const active = { id, iterator, begun: false, canceled: false };
				this.active = active;
				let closed = false;
				const release = (): void => { closed = true; if (this.active === active) this.active = undefined; };
				return {
					next: async () => {
						if (closed || this.disposed) return { done: true, value: undefined };
						if (active.canceled && !active.begun) { release(); return { done: true, value: undefined }; }
						this.assertAvailable();
						active.begun = true;
						try {
							const result = await iterator.next();
							if (result.done) release();
							return result;
						} catch (error) { this.faulted = true; release(); throw error; }
					},
					return: async () => {
						if (closed) return { done: true, value: undefined };
						active.canceled = true;
						if (this.active === active && active.begun) this.runner?.abort();
						try { return await iterator.return?.() ?? { done: true, value: undefined }; }
						catch (error) { this.faulted = true; throw error; }
						finally { release(); }
					},
				};
			},
		};
	}

	steer(input: string, expectedTurnId: symbol): InputAcceptance {
		this.assertAvailable();
		if (!this.accepts(expectedTurnId)) return { accepted: false };
		return this.runner!.steer(input);
	}
	followUp(input: string, expectedTurnId: symbol): InputAcceptance {
		this.assertAvailable();
		if (!this.accepts(expectedTurnId)) return { accepted: false };
		return this.runner!.followUp(input);
	}
	private accepts(id: symbol): boolean {
		const active = this.active;
		return active !== undefined && active.id === id && active.begun && !active.canceled;
	}
	abort(): void {
		if (this.disposed) return;
		if (this.compacting) { this.compactController?.abort(); this.runner?.abort(); }
		if (!this.active) return;
		this.active.canceled = true;
		if (this.active.begun) this.runner?.abort();
	}
	getUsage(): UsageTruthPoint | undefined { return this.runner?.getUsage(); }
	configureContext(settings: Partial<ContextSettings>): void { this.assertAvailable(); this.runner!.configureContext(settings); }
	compact(instructions?: string, emit?: (event: SessionEvent) => void): Promise<CompactionResult> {
		this.assertAvailable();
		if (this.compacting) throw new Error("Agent is compacting");
		const controller = new AbortController();
		this.compactController = controller;
		const active = this.active;
		if (active) { active.canceled = true; this.runner?.abort(); }
		const running = (async () => {
			try {
				await active?.iterator.return?.();
				if (this.active === active) this.active = undefined;
				if (this.disposed) throw new Error("Agent has been disposed");
				return await this.runner!.compact(instructions, emit, controller.signal);
			} catch (error) { this.faulted = true; throw error; }
			finally { this.compacting = undefined; this.compactController = undefined; }
		})();
		this.compacting = running;
		return running;
	}
	respond(response: ResponseEnvelope): boolean { this.assertAvailable(); return this.bus.respond(response); }
	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.disposed = true;
		this.compactController?.abort();
		if (this.active) this.active.canceled = true;
		this.runner?.abort();
		this.bus.close();
		const active = this.active;
		this.disposing = (async () => {
			try { await active?.iterator.return?.(); await this.compacting; }
			finally { this.active = undefined; this.runner = undefined; }
		})();
		return this.disposing;
	}
	private assertAvailable(): void {
		if (this.disposed) throw new Error("Agent has been disposed");
		if (this.faulted) throw new Error("Agent is faulted; recreate it from storage");
	}
}
