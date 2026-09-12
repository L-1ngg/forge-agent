import type { ConfigurationPatch, ConfigurationReceipt } from "./configuration.ts";
import type { RequestEnvelopeUnion, ResponseEnvelope, SessionEvent } from "@forge-agent/protocol";
import type { HarnessTool, ToolInputRewrite } from "@forge-agent/tools";
import type { AgentPort, InputAcceptance, InputQueueOptions } from "./agent-port.ts";
import { createPiPort, type PiPortOptions, type ToolHooks } from "./pi-port.ts";
import { MemoryPermissionStore, type PermissionContext } from "./permission/index.ts";
import { RequestBus } from "./request-bus.ts";
import { MemorySessionStorage, sessionMessages, type SessionStorage } from "./session-storage.ts";
import type { UsageTruthPoint } from "./usage.ts";
import { resolveRetryPolicy, validateRequestLimits, type CompactionResult, type ContextSettings, type RetryPolicy } from "./context/compaction.ts";
import { randomUUID } from "node:crypto";

export interface CreateAgentOptions extends InputQueueOptions {
	toolHooks?: ToolHooks;
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
	tools?: Array<HarnessTool<object, unknown>>;
	toolInputRewrites?: Readonly<Record<string, ToolInputRewrite<object>>>;
	permission?: PermissionContext;
	storage?: SessionStorage;
	requestBus?: RequestBus;
}

export type TurnResult = { status: "success" | "error" | "aborted" | "length" | "deferred" };

export interface AgentTurn extends AsyncIterable<SessionEvent> {
	readonly id: symbol;
	readonly result: Promise<TurnResult>;
}

export interface Agent extends Omit<AgentPort, "runTurn" | "steer" | "followUp" | "setStorage"> {
	compact(instructions?: string, emit?: (event: SessionEvent) => void): Promise<CompactionResult>;
	configureContext(settings: Partial<ContextSettings>): void;
	runTurn(input: string): AgentTurn;
	continue(): AgentTurn;
	waitForIdle(): Promise<void>;
	updateConfiguration(patch: ConfigurationPatch): Promise<ConfigurationReceipt>;
	steer(input: string, expectedTurnId: symbol): InputAcceptance;
	followUp(input: string, expectedTurnId: symbol): InputAcceptance;
	readonly requests: AsyncIterable<RequestEnvelopeUnion>;
	getUsage(): UsageTruthPoint | undefined;
	respond(response: ResponseEnvelope): boolean;
	dispose(): Promise<void>;
}

export type AgentOptions = CreateAgentOptions;

function assertPortCapabilities(port: unknown): asserts port is AgentPort {
	const methods = {
		runTurn: true, continue: true, steer: true, followUp: true, abort: true,
		dispose: true, getUsage: true, setStorage: true, compact: true,
		configureContext: true, updateConfiguration: true,
	} satisfies Record<keyof AgentPort, true>;
	const object = port !== null && (typeof port === "object" || typeof port === "function");
	const missing = Object.keys(methods).filter(name => !object || typeof Reflect.get(port, name) !== "function");
	if (missing.length) throw new TypeError(`Agent factory must provide callable methods: ${missing.join(", ")}`);
}

export async function createAgent(options: CreateAgentOptions, portFactory: (options: PiPortOptions) => AgentPort | Promise<AgentPort> = createPiPort): Promise<Agent> {
	resolveRetryPolicy(options.retry);
	validateRequestLimits(options);
	const storage = options.storage ?? new MemorySessionStorage();
	const requestBus = options.requestBus ?? new RequestBus();
	let port: AgentPort | undefined;
	try {
		const history = await storage.load();
		port = await portFactory({
			sessionId: options.sessionId ?? randomUUID(),
			provider: options.provider,
			model: options.model,
			systemPrompt: options.systemPrompt,
			cwd: options.cwd,
			thinkingLevel: options.thinkingLevel ?? "off",
			...(options.steeringMode ? { steeringMode: options.steeringMode } : {}),
			...(options.followUpMode ? { followUpMode: options.followUpMode } : {}),
			...(options.context ? { context: options.context } : {}),
			...(options.retry ? { retry: options.retry } : {}),
			...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
			...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
			...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
			...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
			...(options.tools ? { tools: options.tools } : {}),
			...(options.toolHooks ? { toolHooks: options.toolHooks } : {}),
			...(options.toolInputRewrites ? { toolInputRewrites: options.toolInputRewrites } : {}),
			permission: { ...options.permission, memory: options.permission?.memory ?? new MemoryPermissionStore() },
			requestBus,
			history: sessionMessages(history),
		});
		assertPortCapabilities(port);
		await port.setStorage(storage);
		return new HostedAgent(port, requestBus);
	} catch (error) {
		if (!options.requestBus) requestBus.close();
		const cleanupErrors: unknown[] = [];
		// A rejected dynamic adapter may itself be missing lifecycle methods.
		try { if (typeof port?.abort === "function") port.abort(); }
		catch (cleanupError) { cleanupErrors.push(cleanupError); }
		try { if (typeof port?.dispose === "function") await port.dispose(); }
		catch (cleanupError) { cleanupErrors.push(cleanupError); }
		if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Agent creation failed and cleanup was incomplete", { cause: error });
		throw error;
	}
}

class HostedAgent implements Agent {
	readonly requests: AsyncIterable<RequestEnvelopeUnion>;
	private active: { id: symbol; iterator: AsyncIterator<SessionEvent>; begun: boolean; canceled: boolean; settled: Promise<void>; finish: (status?: TurnResult["status"]) => void } | undefined;
	private disposed = false;
	private faulted = false;
	private disposing: Promise<void> | undefined;
	private compacting: Promise<CompactionResult> | undefined;
	private compactController: AbortController | undefined;

	constructor(private runner: AgentPort | undefined, private readonly bus: RequestBus) {
		this.requests = bus.requests();
	}

	runTurn(input: string): AgentTurn { return this.startTurn(input); }
	continue(): AgentTurn { return this.startTurn(); }
	waitForIdle(): Promise<void> { return this.active?.settled ?? this.compacting?.then(() => { }) ?? Promise.resolve(); }
	private startTurn(input?: string): AgentTurn {
		this.assertAvailable();
		if (this.compacting) throw new Error("Agent is compacting");
		let started = false;
		const id = Symbol("invocation");
		let resolveResult!: (result: TurnResult) => void;
		const result = new Promise<TurnResult>(resolve => { resolveResult = resolve; });
		let status: TurnResult["status"] = "aborted";
		return {
			id, result,
			[Symbol.asyncIterator]: () => {
				this.assertAvailable();
				if (this.compacting) throw new Error("Agent is compacting");
				if (started) throw new Error("A turn can only be consumed once");
				if (this.active) throw new Error("Agent is already processing a turn");
				started = true;
				const events = input === undefined ? this.runner!.continue() : this.runner!.runTurn(input);
				const iterator = events[Symbol.asyncIterator]();
				let resolveIdle!: () => void;
				const settled = new Promise<void>(resolve => { resolveIdle = resolve; });
				const active = { id, iterator, begun: false, canceled: false, settled, finish: (_status?: TurnResult["status"]) => { } };
				this.active = active;
				let closed = false;
				const release = (outcome?: TurnResult["status"]): void => { if (outcome) status = outcome; closed = true; if (this.active === active) this.active = undefined; resolveResult({ status }); resolveIdle(); };
				active.finish = release;
				return {
					next: async () => {
						if (closed || this.disposed) return { done: true, value: undefined };
						if (active.canceled && !active.begun) { release(); return { done: true, value: undefined }; }
						this.assertAvailable();
						active.begun = true;
						try {
							const result = await iterator.next();
							if (!result.done && result.value.type === "agent_end" && result.value.outcome) status = result.value.outcome;
							if (!result.done && result.value.type === "turn_end") { const reason = result.value.stopReason; status = reason === "error" || reason === "aborted" || reason === "length" || reason === "deferred" ? reason : "success"; }
							if (result.done) release();
							return result;
						} catch (error) { this.faulted = true; status = "error"; release(); throw error; }
					},
					return: async () => {
						if (closed) return { done: true, value: undefined };
						active.canceled = true; status = "aborted";
						if (this.active === active && active.begun) { this.bus.abort(); this.runner?.abort(); }
						try { return await iterator.return?.() ?? { done: true, value: undefined }; }
						catch (error) { this.faulted = true; status = "error"; throw error; }
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
		this.bus.abort();
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
		if (active) { active.canceled = true; this.bus.abort(); this.runner?.abort(); }
		const running = (async () => {
			try {
				await active?.iterator.return?.();
				active?.finish("aborted");
				if (this.active === active) this.active = undefined;
				if (this.disposed) throw new Error("Agent has been disposed");
				return await this.runner!.compact(instructions, emit, controller.signal);
			} catch (error) { this.faulted = true; active?.finish("error"); throw error; }
			finally { this.compacting = undefined; this.compactController = undefined; }
		})();
		this.compacting = running;
		return running;
	}
	updateConfiguration(patch: ConfigurationPatch): Promise<ConfigurationReceipt> { this.assertAvailable(); return this.runner!.updateConfiguration(patch); }
	respond(response: ResponseEnvelope): boolean { this.assertAvailable(); return this.bus.respond(response); }
	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.disposed = true;
		this.compactController?.abort();
		if (this.active) this.active.canceled = true;
		this.bus.close();
		this.runner?.abort();
		const active = this.active;
		const sessionDisposal = this.runner?.dispose();
		this.disposing = (async () => {
			try {
				const settled = await Promise.allSettled([active?.iterator.return?.(), this.compacting, sessionDisposal]);
				const failed = settled.find(result => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
				active?.finish("aborted");
			}
			catch (error) { active?.finish("error"); throw error; }
			finally { this.active = undefined; this.runner = undefined; }
		})();
		return this.disposing;
	}
	private assertAvailable(): void {
		if (this.disposed) throw new Error("Agent has been disposed");
		if (this.faulted) throw new Error("Agent is faulted; recreate it from storage");
	}
}
