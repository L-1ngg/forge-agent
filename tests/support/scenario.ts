import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, MemorySessionStorage, type Agent, type CreateAgentOptions, type SessionEntry } from "../../packages/core/src/sdk.ts";
import type { SessionEvent } from "../../packages/protocol/src/index.ts";
import { Trace, bounded, barrier } from "./control.ts";
import { HttpFixture, type Exchange } from "./http-fixture.ts";
export { Trace, bounded, barrier } from "./control.ts";

/** Owns resources, not execution semantics. Always release gates before awaiting disposal. */
export class Scenario {
	readonly trace = new Trace();
	readonly storage = new MemorySessionStorage();
	private readonly releases: Array<() => void> = [];
	private readonly cleanups: Array<() => unknown | Promise<unknown>> = [];
	private readonly fixtures: HttpFixture[] = [];
	private readonly executions = new Set<Promise<SessionEvent[]>>();
	private closing: Promise<void> | undefined;
	private constructor(readonly id: string, readonly directory: string) {}
	static async open(id: string): Promise<Scenario> {
		const directory = await mkdtemp(join(tmpdir(), "forge-scenario-"));
		const scenario = new Scenario(id, directory);
		try { await Promise.all(["config", "data", "work"].map(name => mkdir(join(directory, name)))); }
		catch (error) { await scenario.close(); throw error; }
		return scenario;
	}
	get cwd(): string { return join(this.directory, "work"); }
	get env(): Record<string, string> { return { XDG_CONFIG_HOME: join(this.directory, "config"), XDG_DATA_HOME: join(this.directory, "data") }; }
	defer(cleanup: () => unknown | Promise<unknown>): void { this.assertOpen(); this.cleanups.push(cleanup); }
	httpFixture(id: string, exchanges: readonly Exchange[]): HttpFixture {
		this.assertOpen();
		const fixture = new HttpFixture(id, exchanges, this.trace);
		this.fixtures.push(fixture);
		return fixture;
	}
	private assertOpen(): void { if (this.closing) throw new Error(`${this.id}: scenario is closing`); }
	gate(label: string) { this.assertOpen(); const gate = barrier(`${this.id}/${label}`); this.releases.push(gate.release); return gate; }
	async agent(options: Omit<CreateAgentOptions, "cwd" | "systemPrompt">, beforeSave?: (entry: SessionEntry) => Promise<void>): Promise<Agent> {
		this.assertOpen();
		const creating = createAgent({
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
		this.defer(async () => (await creating).dispose());
		return creating;
	}
	collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
		this.assertOpen();
		const running = (async () => {
			const result: SessionEvent[] = [];
			for await (const event of events) { this.trace.record("event", event); result.push(event); }
			return result;
		})();
		this.executions.add(running);
		// Retain failures until close, even when an execution finishes during another cleanup.
		void running.catch(() => {});
		return running;
	}
	close(): Promise<void> { return this.closing ??= this.settleResources(); }
	private async settleResources(): Promise<void> {
		const errors: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>, phase: string) => {
			try { await bounded(Promise.resolve().then(operation), `${this.id}/${phase}`); }
			catch (error) { errors.push(error); this.trace.record(`settlement:${phase}`, error instanceof Error ? error.message : String(error)); }
		};
		for (const release of this.releases.splice(0)) await attempt(release, "release");
		// Disposers stop agents/children before fixtures inspect the final request record.
		for (const cleanup of this.cleanups.splice(0).reverse()) await attempt(cleanup, "cleanup");
		for (const running of this.executions) await attempt(() => running, "execution");
		this.executions.clear();
		for (const fixture of this.fixtures) await attempt(() => fixture.verify(), "verify");
		for (const fixture of this.fixtures) await attempt(() => fixture.close(), "fixture-close");
		await attempt(() => rm(this.directory, { recursive: true, force: true }), "directory");
		if (errors.length) throw new AggregateError(errors, `${this.id}: cleanup failed\n${errors.map(error => error instanceof Error ? error.message : String(error)).join("\n")}`);
	}
}

export async function withScenario(id: string, run: (scenario: Scenario) => Promise<void>): Promise<void> {
	const scenario = await Scenario.open(id);
	let failure: unknown;
	let failed = false;
	try { await bounded(run(scenario), `${id}/scenario`); } catch (error) { failed = true; failure = error; }
	try { await scenario.close(); } catch (error) {
		if (!failed) { failed = true; failure = error; }
		else console.error(scenario.trace.format(`${id}/secondary settlement failure`, error));
	}
	if (failed) {
		console.error(scenario.trace.format(id, failure));
		throw failure;
	}
}
