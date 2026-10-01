import type { InputCompletionItem } from "@forge-agent/protocol";
import type { InteractionEvent, InteractionOptions, InteractionPhase, InteractionPort, InteractionRead, InteractionSnapshot, SessionView, SubmitMode } from "./contracts.ts";
import { InteractionScope } from "./interaction-scope.ts";
import { SessionInteraction } from "./session-interaction.ts";

export class SessionCoordinator<P extends InteractionPort = InteractionPort> {
	private readonly root = new InteractionScope();
	private active: SessionInteraction<P>;
	private phase: InteractionPhase = "active";
	private started = false;
	private readonly listeners = new Set<(event: InteractionEvent) => void>();
	private currentSnapshot: InteractionSnapshot;
	private switching: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private fatalError: unknown;

	constructor(private readonly options: InteractionOptions<P>) {
		this.active = this.create(options.sessions?.current);
		this.currentSnapshot = Object.freeze({ ...this.active.snapshot(), phase: this.phase });
	}
	private create(view?: SessionView<P>): SessionInteraction<P> {
		let interaction!: SessionInteraction<P>;
		interaction = new SessionInteraction(this.options, this.root.child(), event => {
			if (this.active === interaction) this.publish(event);
		}, () => { if (this.active === interaction) this.update(); }, view);
		return interaction;
	}
	snapshot(): InteractionSnapshot { return this.currentSnapshot; }
	subscribe(listener: (event: InteractionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private publish(event: InteractionEvent): void {
		if (!this.started || this.phase === "closing" || this.phase === "closed") return;
		for (const listener of [...this.listeners]) listener(event);
	}
	private update(): void {
		this.currentSnapshot = Object.freeze({ ...this.active.snapshot(), phase: this.phase });
		this.publish({ type: "state_changed", snapshot: this.currentSnapshot });
	}
	start(): void {
		if (this.started) return;
		if (this.phase !== "active") throw new Error("Session coordinator is closed");
		this.started = true;
		const view = this.active.view;
		this.publish({ type: "session_activated", history: view?.history ?? this.options.history ?? [], ...(view ? { sessionId: view.id, hasHistory: view.hasHistory() } : {}) });
		this.active.start();
	}
	submit(input: string, mode: SubmitMode = "queue"): void { if (this.started && this.phase === "active") this.active.submit(input, mode); }
	interrupt(): void { if (this.started && this.phase === "active") this.active.interrupt(); }
	recallInput(): string | undefined { return this.phase === "active" ? this.active.recallInput() : undefined; }
	respond(response: unknown): boolean { return this.started && this.phase === "active" && this.active.respond(response); }
	reconcileRequests(): void { if (this.started && this.phase === "active") this.active.reconcileRequests(); }
	requestData(request: InteractionRead): void { if (this.started && this.phase === "active") this.active.requestData(request); }
	cancelData(kind: InteractionRead["kind"]): void { this.active.cancelData(kind); }
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number } { return this.active.applyCompletion(input, cursor, item, prefix); }
	switchTo(id?: string): void {
		if (!this.started || this.phase !== "active") return;
		const host = this.options.sessions;
		if (!host) { this.publish({ type: "notice", text: "Session switching unavailable" }); return; }
		if (id === this.active.view?.id) return;
		const old = this.active;
		this.phase = "switching"; old.invalidate();
		this.publish({ type: "interaction_invalidated" }); this.update();
		this.switching = Promise.resolve().then(() => host.switchTo(id, async () => {
			if (this.phase !== "switching") throw new Error("Session coordinator is closing");
			this.publish({ type: "notice", text: "正在结束当前任务…" });
			await old.drain(true); old.assertSettled();
		})).then(next => {
			if (this.phase !== "switching") return;
			const previous = old.view ? { id: old.view.id, hasHistory: old.view.hasHistory() } : undefined;
			old.dispose(); this.active = this.create(next); this.phase = "active";
			this.publish({ type: "session_activated", sessionId: next.id, history: next.history, hasHistory: next.hasHistory(), ...(previous ? { previous } : {}) });
			this.active.start();
		}, error => {
			if (this.phase !== "switching") return;
			this.phase = "active"; old.resume();
			this.publish({ type: "interaction_ready" });
			this.publish({ type: "notice", text: `会话切换失败：${error instanceof Error ? error.message : String(error)}` });
		}).finally(() => { this.switching = undefined; this.update(); });
		void this.switching.catch(error => {
			this.fatalError = error;
			this.publish({ type: "notice", text: String(error) });
			this.publish({ type: "view_command", command: "quit" });
			void this.close().catch(() => {});
		});
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		let resolve!: () => void, reject!: (error: unknown) => void;
		this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
		this.phase = "closing";
		void (async () => {
			const errors: unknown[] = this.fatalError === undefined ? [] : [this.fatalError];
			try { this.active.invalidate(); this.update(); } catch (error) { errors.push(error); }
			// Mark the host closed immediately, before awaiting a switch's beforeRelease.
			const host = this.options.sessions;
			const release = (async () => { if (host) await host.dispose(); else this.active.binding.requestBus.close(); })();
			const drain = this.active.drain(true);
			const outcomes = await Promise.allSettled([release, drain, this.switching]);
			errors.push(...outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []));
			try { this.active.dispose(); } catch (error) { errors.push(error); }
			errors.push(...this.root.dispose());
			this.phase = "closed"; this.started = false; this.update(); this.listeners.clear();
			if (errors.length) throw new AggregateError(errors, "Session close failed");
		})().then(resolve, reject);
		return this.closing;
	}
}
