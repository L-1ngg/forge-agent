import { expect, test } from "bun:test";
import { join } from "node:path";
import { withScenario } from "../tests/support/scenario.ts";
import { TestEvidence } from "./test-evidence.ts";
import { run } from "./test-offline.ts";

const plan = { contract: ["module.test.ts"], integration: ["sdk.test.ts"], cli: ["cli.test.ts"] };

test("fresh and concurrent test invocations cannot reuse or overwrite another run's results", () => withScenario("evidence-concurrent", async scenario => {
	const [first, second] = await Promise.all([TestEvidence.open(scenario.cwd, "all", plan, { bun: Bun.version }), TestEvidence.open(scenario.cwd, "all", plan, { bun: Bun.version })]);
	expect(first.directory).not.toBe(second.directory);
	await Bun.write(join(first.directory, "contract.xml"), "old passed report");
	expect(await Bun.file(join(second.directory, "contract.xml")).exists()).toBe(false);
	first.select("contract", plan.contract); second.select("contract", plan.contract);
	first.record("contract", 0, 1); second.record("contract", 7, 2);
	await first.finish(0); await second.finish(7);
	expect((await Bun.file(join(first.directory, "summary.json")).json()).status).toBe("passed");
	expect((await Bun.file(join(second.directory, "summary.json")).json()).groups).toMatchObject([{ status: "failed", code: 7 }]);
	expect(await Bun.file(join(scenario.cwd, "latest-all.json")).json()).toEqual({ runId: second.directory.split("/").at(-1), code: 7 });
}));

test("setup failure records unexecuted groups instead of claiming a previous passing report", () => withScenario("evidence-setup", async scenario => {
	const evidence = await TestEvidence.open(scenario.cwd, "all", plan, {});
	evidence.select("contract", plan.contract);
	await evidence.finish(1, "probe failed");
	const summary = await Bun.file(join(evidence.directory, "summary.json")).json();
	expect(summary).toMatchObject({ status: "failed", error: "probe failed", groups: [{ status: "not-run" }] });
}));

test("subprocess evidence preserves nonzero exit and explicitly replaces existing raw logs", () => withScenario("evidence-child", async scenario => {
	const log = join(scenario.cwd, "child.log");
	await Bun.write(log, "STALE_OUTPUT\n");
	const code = await run([process.execPath, "-e", 'console.log("CURRENT_OUTPUT"); process.exit(7)'], process.env, log);
	expect(code).toBe(7);
	expect(await Bun.file(log).text()).toBe("CURRENT_OUTPUT\n");
}));
