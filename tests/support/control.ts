/** A deadline is a failure bound, never a scheduling mechanism. */
export async function bounded<T>(promise: PromiseLike<T>, label: string, ms = 4000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
		})]);
	} finally { clearTimeout(timer); }
}

export function barrier(label: string) {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { release, wait: () => bounded(promise, label) };
}

export function nextTurn(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/** Poll observations, not business time; report the last public state on failure. */
export async function waitFor(check: () => boolean | Promise<boolean>, label: string, options: { timeoutMs?: number; diagnostics?: () => unknown } = {}): Promise<void> {
	const deadline = performance.now() + (options.timeoutMs ?? 4000);
	try {
		while (true) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new Error(`Timed out: ${label}`);
			if (await bounded(Promise.resolve().then(check), label, remaining)) return;
			await Bun.sleep(Math.min(5, Math.max(0, deadline - performance.now())));
		}
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}${options.diagnostics ? `\nLast observation: ${JSON.stringify(options.diagnostics())}` : ""}`, { cause: error });
	}
}

export class Trace {
	readonly entries: Array<{ order: number; kind: string; value: unknown }> = [];
	record(kind: string, value: unknown): void {
		this.entries.push({ order: this.entries.length, kind, value: structuredClone(value) });
	}
	format(id: string, error: unknown): string {
		return JSON.stringify({ id, environment: { bun: Bun.version, os: process.platform, arch: process.arch, fastCheck: "4.3.0" }, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), trace: this.entries }, (key, value) => /^(authorization|api.?key|token|secret|cookie)$/i.test(key) ? "[redacted]" : value, 2);
	}
}
