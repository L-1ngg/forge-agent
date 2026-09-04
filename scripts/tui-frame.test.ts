import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
