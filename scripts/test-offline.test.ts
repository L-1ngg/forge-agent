import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { bounded, withScenario } from "../tests/support/scenario.ts";

test("runner setup failure writes fresh failed evidence with unexecuted groups", () => withScenario("runner-setup-failure", async scenario => {
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "test-offline.ts"), "contract"], {
		env: { ...process.env, TMPDIR: join(scenario.cwd, "missing-parent") }, stdout: "pipe", stderr: "pipe",
	});
	scenario.defer(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await bounded(child.exited, "runner cleanup"); });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect(code, stderr).toBe(1);
	const directory = JSON.parse(stdout.trim()).evidence as string;
	const summary = await Bun.file(join(directory, "summary.json")).json();
	expect(summary).toMatchObject({ status: "failed", groups: [{ group: "contract", status: "not-run" }] });
	expect(summary.environment.source.sha256).toMatch(/^[a-f0-9]{64}$/);
	expect(summary.error).toContain("ENOENT");
	expect(await Bun.file(join(directory, "contract.xml")).exists()).toBe(false);
}));
