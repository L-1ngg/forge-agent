import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { withScenario } from "../tests/support/scenario.ts";
import { sourceIdentity } from "./test-source.ts";

test("source evidence distinguishes unchanged HEAD from dirty, untracked and deleted executable inputs", () => withScenario("source-identity", async scenario => {
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: scenario.cwd, stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	git("init", "-q");
	await Bun.write(join(scenario.cwd, "module.ts"), "export const value = 1;\n"); git("add", "module.ts");
	git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
	const initial = await sourceIdentity(scenario.cwd); expect(initial.dirty).toBe(false);
	await Bun.write(join(scenario.cwd, "module.ts"), "export const value = 2;\n");
	const dirty = await sourceIdentity(scenario.cwd); expect(dirty.head).toBe(initial.head); expect(dirty.sha256).not.toBe(initial.sha256); expect(dirty.dirty).toBe(true);
	await Bun.write(join(scenario.cwd, "new.test.ts"), "test('new', () => {});\n");
	const untracked = await sourceIdentity(scenario.cwd); expect(untracked.sha256).not.toBe(dirty.sha256);
	await unlink(join(scenario.cwd, "module.ts")); expect((await sourceIdentity(scenario.cwd)).sha256).not.toBe(untracked.sha256);
}));
