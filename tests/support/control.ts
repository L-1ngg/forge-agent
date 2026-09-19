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

export class Trace {
	readonly entries: Array<{ order: number; kind: string; value: unknown }> = [];
	record(kind: string, value: unknown): void {
		this.entries.push({ order: this.entries.length, kind, value: structuredClone(value) });
	}
	format(id: string, error: unknown): string {
		return JSON.stringify({ id, environment: { bun: Bun.version, os: process.platform, arch: process.arch, piAi: "0.85.1", fastCheck: "4.3.0" }, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), trace: this.entries }, (key, value) => /^(authorization|api.?key|token|secret|cookie)$/i.test(key) ? "[redacted]" : value, 2);
	}
}
