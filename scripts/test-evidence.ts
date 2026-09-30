import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { basename, join } from "node:path";

export interface GroupResult {
	group: string;
	files: readonly string[];
	status: "not-run" | "passed" | "failed";
	code?: number;
	elapsedMs?: number;
}

/** One invocation owns all of its evidence, including failures before tests start. */
export class TestEvidence {
	private readonly results = new Map<string, GroupResult>();
	private constructor(readonly directory: string, private readonly selection: string, private readonly environment: Record<string, unknown>) {}
	static async open(outputRoot: string, selection: string, plan: unknown, environment: Record<string, unknown>): Promise<TestEvidence> {
		await mkdir(outputRoot, { recursive: true });
		const directory = await mkdtemp(join(outputRoot, "run-"));
		const evidence = new TestEvidence(directory, selection, environment);
		await Bun.write(join(directory, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
		await evidence.write("running");
		return evidence;
	}
	static async resume(directory: string): Promise<TestEvidence> {
		const summary = await Bun.file(join(directory, "summary.json")).json();
		const evidence = new TestEvidence(directory, summary.selection, summary.environment);
		for (const result of summary.groups as GroupResult[]) evidence.results.set(result.group, result);
		return evidence;
	}
	async setPlan(plan: unknown): Promise<void> { await Bun.write(join(this.directory, "plan.json"), JSON.stringify(plan, null, 2) + "\n"); }
	checkpoint(): Promise<void> { return this.write("running"); }
	select(group: string, files: readonly string[]): void { this.results.set(group, { group, files: [...files], status: "not-run" }); }
	record(group: string, code: number, elapsedMs: number): void {
		const selected = this.results.get(group);
		if (!selected) throw new Error(`Evidence group was not selected: ${group}`);
		this.results.set(group, { ...selected, code, elapsedMs: Math.round(elapsedMs), status: code === 0 ? "passed" : "failed" });
	}
	private async write(status: "running" | "passed" | "failed", error?: string): Promise<void> {
		await Bun.write(join(this.directory, "summary.json"), JSON.stringify({ runId: basename(this.directory), selection: this.selection, status, environment: this.environment, groups: [...this.results.values()], ...(error ? { error } : {}) }, null, 2) + "\n");
	}
	async finish(code: number, error?: string): Promise<void> {
		await this.write(code === 0 ? "passed" : "failed", error);
		const index = join(this.directory, "latest.json");
		await Bun.write(index, JSON.stringify({ runId: basename(this.directory), code }, null, 2) + "\n");
		await rename(index, join(this.directory, "..", `latest-${this.selection}.json`));
	}
}
