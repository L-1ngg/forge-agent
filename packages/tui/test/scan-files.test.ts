import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles } from "../src/index.ts";

test("scanFiles scans synchronously and filters by path prefix", async () => {
	const root = await mkdtemp(join(tmpdir(), "myh-scan-"));
	try {
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "src2"), { recursive: true });
		await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
		await writeFile(join(root, "src", "app.ts"), "");
		await writeFile(join(root, "src2", "wrong.ts"), "");
		await writeFile(join(root, "README.md"), "");
		await writeFile(join(root, "node_modules", "ignored", "bad.ts"), "");
		expect(scanFiles(root, "src/")).toEqual(["src/app.ts"]);
		expect(scanFiles(root, "src")).toEqual(["src/app.ts"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
