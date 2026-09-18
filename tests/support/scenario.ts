import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, MemorySessionStorage, type Agent, type CreateAgentOptions, type SessionEntry } from "../../packages/core/src/sdk.ts";
import type { SessionEvent } from "../../packages/protocol/src/index.ts";

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

/** Owns resources, not execution semantics. Always release gates before awaiting disposal. */
export class Scenario {
	readonly trace = new Trace();
	readonly storage = new MemorySessionStorage();
	private readonly releases: Array<() => void> = [];
	private readonly cleanups: Array<() => unknown | Promise<unknown>> = [];
	private constructor(readonly id: string, readonly directory: string) {}
	static async open(id: string): Promise<Scenario> {
		const directory = await mkdtemp(join(tmpdir(), "forge-scenario-"));
		const scenario = new Scenario(id, directory);
		scenario.defer(() => rm(directory, { recursive: true, force: true }));
		await Promise.all(["config", "data", "work"].map(name => mkdir(join(directory, name))));
		return scenario;
	}
	get cwd(): string { return join(this.directory, "work"); }
	get env(): Record<string, string> { return { XDG_CONFIG_HOME: join(this.directory, "config"), XDG_DATA_HOME: join(this.directory, "data") }; }
	defer(cleanup: () => unknown | Promise<unknown>): void { this.cleanups.push(cleanup); }
	gate(label: string) { const gate = barrier(`${this.id}/${label}`); this.releases.push(gate.release); return gate; }
	async agent(options: Omit<CreateAgentOptions, "cwd" | "systemPrompt">, beforeSave?: (entry: SessionEntry) => Promise<void>): Promise<Agent> {
		const agent = await createAgent({
			cwd: this.cwd, systemPrompt: "Deterministic test", context: { enabled: false }, retry: { enabled: false }, ...options,
			storage: options.storage ?? {
				load: () => this.storage.load(),
				append: async entry => {
					this.trace.record("save:start", entry);
					await beforeSave?.(entry);
					await this.storage.append(entry);
					this.trace.record("save:end", entry.id);
				},
			},
		});
		this.defer(() => agent.dispose());
		return agent;
	}
	async collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
		const result: SessionEvent[] = [];
		for await (const event of events) { this.trace.record("event", event); result.push(event); }
		return result;
	}
	async close(): Promise<void> {
		for (const release of this.releases) release();
		const errors: unknown[] = [];
		for (const cleanup of this.cleanups.splice(0).reverse()) {
			try { await bounded(Promise.resolve().then(cleanup), `${this.id}/cleanup`); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw new AggregateError(errors, `${this.id}: cleanup failed`);
	}
}

export async function withScenario(id: string, run: (scenario: Scenario) => Promise<void>): Promise<void> {
	const scenario = await Scenario.open(id);
	let failure: unknown;
	try { await bounded(run(scenario), `${id}/scenario`); } catch (error) { failure = error; }
	// Capture before cleanup: cleanup may add events or remove evidence files.
	const diagnostic = failure === undefined ? undefined : scenario.trace.format(id, failure);
	try { await scenario.close(); } catch (error) {
		if (failure === undefined) failure = error;
		else console.error(`${id}: secondary cleanup failure`, error);
	}
	if (failure !== undefined) {
		console.error(diagnostic ?? scenario.trace.format(id, failure));
		throw failure;
	}
}
