import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tui-frame dump then compare against itself is equal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tui-frame-"));
	try {
		const path = join(dir, "idle.json");
		const dump = Bun.spawn(["bun", "scripts/tui-frame.ts", "dump", "--out", path], { stdout: "pipe", stderr: "pipe" });
		expect(await dump.exited).toBe(0);
		const body = JSON.parse(await readFile(path, "utf8")) as { columns: number; rows: number; cells: unknown[][] };
		expect(body.columns).toBe(80);
		expect(body.rows).toBe(24);
		expect(body.cells).toHaveLength(24);
		const compare = Bun.spawn(["bun", "scripts/tui-frame.ts", "compare", path, path], { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(compare.stdout).text();
		expect(await compare.exited).toBe(0);
		expect(JSON.parse(stdout).status).toBe("equal");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("tui-frame compare checks embedded environment manifests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tui-manifest-"));
	try {
		const golden = JSON.parse(await readFile("packages/tui/test/fixtures/golden/user-hello-40.json", "utf8"));
		const expected = join(directory, "expected.json");
		const actual = join(directory, "actual.json");
		await writeFile(expected, JSON.stringify(golden));
		golden.environment.timezone = "Asia/Shanghai";
		await writeFile(actual, JSON.stringify(golden));
		const child = Bun.spawn(["bun", "scripts/tui-frame.ts", "compare", expected, actual], { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(1);
		expect(JSON.parse(output).status).toBe("environment-mismatch");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
