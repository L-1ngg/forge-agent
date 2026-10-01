interface ScopedOperation<T> {
	work(signal: AbortSignal, publish: (effect: () => void) => void): T | PromiseLike<T>;
	success?(value: T): void;
	error?(error: unknown): void;
	finish?(): void;
}

/** Cooperative cancellation and publication ownership are deliberately separate. */
export class InteractionScope {
	private readonly controller = new AbortController();
	private readonly children = new Set<InteractionScope>();
	private readonly disposers = new Set<() => void>();
	private readonly operations = new Map<string, InteractionScope>();
	private alive = true;
	get signal(): AbortSignal { return this.controller.signal; }
	get active(): boolean { return this.alive; }
	child(): InteractionScope {
		const child = new InteractionScope();
		if (!this.alive) child.dispose();
		else {
			this.children.add(child);
			child.defer(() => this.children.delete(child));
		}
		return child;
	}
	defer(dispose: () => void): void {
		if (this.alive) this.disposers.add(dispose);
		else dispose();
	}
	cancel(key: string): void { this.operations.get(key)?.dispose(); }
	has(key: string): boolean { return this.operations.has(key); }
	run<T>(key: string, policy: "replace" | "reject", task: ScopedOperation<T>): boolean {
		if (!this.alive || policy === "reject" && this.operations.has(key)) return false;
		this.cancel(key);
		const operation = this.child();
		this.operations.set(key, operation);
		operation.defer(() => { if (this.operations.get(key) === operation) this.operations.delete(key); });
		const owns = () => operation.active && this.operations.get(key) === operation;
		const publish = (effect: () => void) => { if (owns()) effect(); };
		// Register ownership before user code or an abort listener can reenter.
		void Promise.resolve().then(async () => {
			if (!owns()) return;
			try { const value = await task.work(operation.signal, publish); publish(() => task.success?.(value)); }
			catch (error) { publish(() => task.error?.(error)); }
		})
			.finally(() => {
				const valid = owns();
				const errors = operation.dispose();
				if (valid && this.alive && !this.operations.has(key)) {
					for (const error of errors) task.error?.(error);
					task.finish?.();
				}
			}).catch(() => {});
		return true;
	}
	dispose(): unknown[] {
		if (!this.alive) return [];
		this.alive = false;
		const errors: unknown[] = [];
		try { this.controller.abort(); } catch (error) { errors.push(error); }
		for (const child of this.children) errors.push(...child.dispose());
		for (const dispose of this.disposers) { try { dispose(); } catch (error) { errors.push(error); } }
		this.children.clear(); this.disposers.clear(); this.operations.clear();
		return errors;
	}
}
