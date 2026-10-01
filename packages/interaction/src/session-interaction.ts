import type { InputCompletionItem, RequestEnvelopeUnion, RequestKind, RequestOutcome, SessionEvent, TurnResult } from "@forge-agent/protocol";
import type { CompletionSource, InteractionEvent, InteractionOptions, InteractionPort, InteractionRead, InteractionSnapshot, SessionBinding, SessionView, SubmitMode } from "./contracts.ts";
import { InputFlow } from "./input-flow.ts";
import { InteractionScope } from "./interaction-scope.ts";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function readOnly<T>(value: T): T {
	const copy = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item && typeof item === "object" && !ArrayBuffer.isView(item)) {
			for (const child of Object.values(item)) freeze(child);
			Object.freeze(item);
		}
	};
	freeze(copy); return copy;
}

/** Owns one activation's operations, without owning execution or presentation. */
export class SessionInteraction<P extends InteractionPort> {
	private readonly inputs = new InputFlow();
	private readonly pending = new Map<string, RequestEnvelopeUnion>();
	private auxiliary: InteractionScope;
	private readonly source: CompletionSource | undefined;
	readonly binding: SessionBinding<P>;
	private foreground: { kind: "turn" | "compact"; done: Promise<void>; scope: InteractionScope } | undefined;
	private pendingCompact: { instructions: string | undefined } | undefined;
	private executionError: unknown;
	private blocked = false;
	private facts: Omit<InteractionSnapshot, "phase">;

	constructor(private readonly options: InteractionOptions<P>, readonly scope: InteractionScope, private readonly emit: (event: InteractionEvent) => void, private readonly changed: () => void, readonly view?: SessionView<P>) {
		this.binding = Object.freeze({ port: view?.port ?? options.port, requestBus: view?.requestBus ?? options.requestBus, ...(view ? { sessionId: view.id } : {}) });
		this.auxiliary = scope.child();
		this.source = options.createCompletionSource?.(this.binding) ?? options.completionSource;
		this.facts = this.readFacts();
	}
	private readFacts(): Omit<InteractionSnapshot, "phase"> {
		const usage = this.binding.port.getUsage?.();
		return Object.freeze({
			...(this.view ? { sessionId: this.view.id, hasHistory: this.view.hasHistory() } : {}),
			canSwitch: !!this.options.sessions,
			activity: this.foreground?.kind === "compact" ? "compacting" : this.foreground ? this.inputs.isPaused ? "stopping" : "working" : "idle",
			hasPendingInputs: this.inputs.hasPending,
			queuedCount: this.inputs.queuedCount,
			inputLabels: Object.freeze(this.inputs.labels()),
			requests: Object.freeze([...this.pending.values()]),
			...(usage ? { usage: readOnly(usage) } : {}),
		});
	}
	snapshot(): Omit<InteractionSnapshot, "phase"> { return this.facts; }
	private update(): void { this.facts = this.readFacts(); this.changed(); }
	private notice(text: string): void { this.emit({ type: "notice", text }); }
	private restore(inputs: readonly string[]): void { if (inputs.length) this.emit({ type: "restore_inputs", inputs }); }
	private pause(): void { this.restore(this.inputs.pause()); }
	start(): void {
		const bus = this.binding.requestBus;
		this.scope.defer(this.binding.port.mcp?.subscribe(event => {
			if (this.scope.active && ["state", "authentication", "diagnostic"].includes(event.type)) this.notice(`MCP ${event.serverId}: ${event.state ?? event.message ?? event.type}`);
		}) ?? (() => {}));
		this.scope.run("requests", "reject", {
			work: async (signal, publish) => {
				for await (const request of bus.requests()) {
					if (signal.aborted) return;
					publish(() => {
						if (bus.isPending?.(request.id) === false) return;
						const outcome = bus.getTerminal?.(request.id);
						const material = readOnly(request);
						this.pending.set(request.id, material);
						this.update(); this.emit({ type: "request_added", request: material });
						if (outcome) this.endRequest(request.id, outcome);
					});
				}
			}, error: () => { if (!this.blocked) this.emit({ type: "view_command", command: "quit" }); },
		});
		this.scope.run("terminals", "reject", {
			work: async (signal, publish) => {
				for await (const outcome of bus.terminals()) {
					if (signal.aborted) return;
					publish(() => { this.endRequest(outcome.requestId, outcome); this.reconcileRequests(); });
				}
			}, error: () => { if (!this.blocked) this.emit({ type: "view_command", command: "quit" }); },
		});
		this.update();
	}
	private endRequest(id: string, outcome?: RequestOutcome<RequestKind>): void {
		if (!this.pending.delete(id)) return;
		this.update(); this.emit({ type: "request_ended", requestId: id, ...(outcome ? { outcome } : {}) });
	}
	reconcileRequests(): void {
		const bus = this.binding.requestBus;
		if (!bus.isPending) return;
		for (const id of this.pending.keys()) if (!bus.isPending(id)) this.endRequest(id, bus.getTerminal?.(id));
	}
	respond(response: unknown): boolean {
		if (this.blocked || !this.scope.active || !response || typeof response !== "object" || !("id" in response) || typeof response.id !== "string") return false;
		this.reconcileRequests();
		if (!this.pending.has(response.id) || this.binding.requestBus.getTerminal?.(response.id) || !this.binding.requestBus.respond(response)) return false;
		// The caller projects the chosen response; later terminal notifications are once-only.
		this.pending.delete(response.id); this.update();
		return true;
	}
	recallInput(): string | undefined { const input = this.inputs.recall(); this.update(); return input; }
	submit(input: string, mode: SubmitMode): void {
		if (this.blocked || !this.scope.active) return;
		const command = input.trim();
		if (["/new", "/resume", "/clear", "/help", "/quit", "/exit"].includes(command)) {
			this.emit({ type: "view_command", command: command === "/exit" ? "quit" : command.slice(1) as "new" | "resume" | "clear" | "help" | "quit" }); return;
		}
		if (command === "/compact" || command.startsWith("/compact ")) { this.compact(command.slice(8).trim() || undefined); return; }
		if ((command === "/mcp" || command.startsWith("/mcp ")) && !/^\/mcp use-(?:prompt|resource)\s/.test(command)) {
			if (!this.options.mcpCommand) this.notice("MCP management unavailable");
			else this.manage("catalog", (report, signal) => this.options.mcpCommand!(command, report, signal, this.binding));
			return;
		}
		if (command === "/skills" || command.startsWith("/skills ")) {
			if (!this.options.skillsCommand) this.notice("Skills management unavailable");
			else this.manage("catalog", (report, signal) => this.options.skillsCommand!(command, report, signal, this.binding));
			return;
		}
		if (command === "/memory" || command.startsWith("/memory ")) {
			if (!this.options.memoryCommand) this.notice("Memory management unavailable");
			else this.manage("memory", (_report, signal) => this.options.memoryCommand!(command.slice(7).trim(), signal, this.binding));
			return;
		}
		this.sendInput(input, mode);
	}
	private sendInput(input: string, mode: SubmitMode): void {
		if (this.blocked || !this.scope.active) return;
		if (this.foreground) {
			if (mode === "replace") { this.inputs.stopAndSend(input || undefined); this.binding.port.abort?.(); }
			else if (input) this.inputs.enqueue(input);
			this.update();
		} else if (input) this.launch("turn", input);
	}
	interrupt(): void { this.pause(); this.binding.port.abort?.(); this.update(); }
	invalidate(): void {
		this.blocked = true;
		if (this.auxiliary.has("memory") || this.auxiliary.has("catalog")) this.notice("旧会话的管理操作已失效；需要时请重新执行命令。");
		this.auxiliary.dispose(); this.pause(); this.update();
	}
	resume(): void { this.auxiliary = this.scope.child(); this.blocked = false; this.update(); }
	async drain(abort: boolean): Promise<void> {
		if (abort) this.binding.port.abort?.();
		await this.foreground?.done;
	}
	assertSettled(): void { if (this.executionError !== undefined) throw this.executionError; }
	dispose(): void {
		const errors = this.scope.dispose(); this.pending.clear();
		if (errors.length) throw new AggregateError(errors, "Interaction cleanup failed");
	}
	private manage(slot: string, work: (report: (text: string) => void, signal: AbortSignal) => Promise<void | { text: string; prompt?: string }>): void {
		if (!this.auxiliary.run(slot, "reject", {
			work: (signal, publish) => work(text => publish(() => this.notice(text)), signal),
			success: result => { if (result) { this.notice(result.text); if (result.prompt) this.sendInput(result.prompt, "queue"); } },
			error: error => this.notice(errorText(error)), finish: () => this.update(),
		})) this.notice("Management operation is still running");
	}
	requestData(request: InteractionRead): void {
		if (this.blocked || !this.scope.active) return;
		this.auxiliary.run(request.kind, "replace", {
			work: async signal => {
				if (request.kind === "suggestions") return { kind: request.kind, status: "success", value: await this.source?.getSuggestions(request.input, request.cursor, { signal }) ?? null } as const;
				if (request.kind === "sessions" && this.options.sessions) return { kind: request.kind, status: "success", value: await this.options.sessions.list() } as const;
				if (request.kind === "preview" && this.options.sessions?.preview) return { kind: request.kind, status: "success", id: request.id, value: await this.options.sessions.preview(request.id, request.cached) } as const;
				return { kind: request.kind, status: "unavailable", message: request.kind === "sessions" ? "Session switching unavailable" : "当前宿主不支持预览" } as const;
			},
			success: result => this.emit({ type: "data_result", result }),
			error: error => this.emit({ type: "data_result", result: { kind: request.kind, status: "error", message: errorText(error) } }),
		});
	}
	cancelData(kind: InteractionRead["kind"]): void { this.auxiliary.cancel(kind); }
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number } {
		return this.source?.applyCompletion(input, cursor, item, prefix) ?? { input, cursor };
	}
	private compact(instructions: string | undefined): void {
		if (this.pendingCompact || this.foreground?.kind === "compact") return;
		if (!this.binding.port.compact) { this.notice("Compaction unavailable"); return; }
		this.pause();
		if (this.foreground) {
			this.pendingCompact = { instructions }; this.binding.port.abort?.(); this.update();
		} else this.launch("compact", instructions);
	}
	private launch(kind: "turn" | "compact", input: string | undefined): void {
		let resolve!: () => void;
		const task = { kind, done: new Promise<void>(done => { resolve = done; }), scope: this.scope.child() };
		this.foreground = task; this.executionError = undefined;
		if (kind === "turn") this.inputs.start();
		this.update();
		void (async () => {
			let current = input;
			if (kind === "turn") current = await this.runInputs(current!);
			const compact = kind === "compact" ? { instructions: input } : this.pendingCompact;
			this.pendingCompact = undefined;
			if (compact && !this.blocked && this.executionError === undefined) {
				if (current !== undefined) this.inputs.stopAndSend(current);
				task.kind = "compact"; this.update();
				try { await this.binding.port.compact!(compact.instructions, event => { if (task.scope.active) this.handleEvent(event); }); }
				catch (error) { this.executionError = error; this.notice(errorText(error)); }
				const decision = this.inputs.settle("success", this.executionError !== undefined, this.blocked);
				this.restore(decision.restore); current = decision.next;
			}
			return current;
		})().then(next => {
			if (this.foreground === task) { this.foreground = undefined; task.scope.dispose(); }
			resolve();
			if (next !== undefined && !this.blocked && this.scope.active) this.launch("turn", next);
			else this.update();
		}, error => {
			this.executionError = error; this.pause(); this.notice(errorText(error));
			if (this.foreground === task) { this.foreground = undefined; task.scope.dispose(); this.update(); }
			resolve();
		});
	}
	private async runInputs(input: string): Promise<string | undefined> {
		let current: string | undefined = input;
		while (current !== undefined && this.scope.active) {
			this.inputs.begin(current);
			let status: TurnResult["status"] | undefined;
			let failed = false;
			let prepared;
			try { prepared = this.options.prepareInput?.(current) ?? current; }
			catch (error) { this.notice(errorText(error)); this.restore(this.inputs.settle("error", false, this.blocked).restore); return; }
			try {
				const turn = this.binding.port.runTurn(prepared);
				const result = turn.result;
				void result.catch(() => {});
				let streamError: unknown;
				try { for await (const event of turn) { this.inputs.observe(event); this.handleEvent(event); } }
				catch (error) { streamError = error; }
				status = (await result).status;
				if (streamError !== undefined) throw streamError;
			} catch (error) { failed = true; this.executionError = error; this.notice(errorText(error)); }
			const decision = this.inputs.settle(status, failed, this.blocked);
			this.restore(decision.restore); this.update(); current = decision.next;
			if (this.pendingCompact) return current;
		}
		return current;
	}
	private handleEvent(event: SessionEvent): void { this.update(); this.emit({ type: "session_event", event }); }
}
