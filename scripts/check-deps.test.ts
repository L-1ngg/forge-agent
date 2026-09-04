import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findViolations } from "./check-deps.ts";

test("dependency check rejects a direct UI blocking call", async () => {
	const rootPath = await mkdtemp(join(tmpdir(), "myh-deps-"));
	try {
		for (const packageName of ["protocol", "tools", "core", "tui", "cli"]) {
			await mkdir(join(rootPath, "packages", packageName, "src"), { recursive: true });
			await writeFile(join(rootPath, "packages", packageName, "package.json"), "{}");
		}
		await writeFile(join(rootPath, "packages", "core", "src", "illegal-ui.ts"), "ui.prompt();\nui.confirm();\nui.ask();\nprompt();\nconfirm();\n");
		const violations = await findViolations(new URL(`file://${rootPath}/`));
		expect(violations).toContain("packages/core/src/illegal-ui.ts must not call UI blocking APIs directly");
		expect(violations).toContain("packages/core/src/illegal-ui.ts must not call prompt/confirm directly");
	} finally {
		await rm(rootPath, { recursive: true, force: true });
	}
});

test("dependency check allows Node built-ins in the TUI package", async () => {
	const rootPath = await mkdtemp(join(tmpdir(), "myh-deps-node-"));
	try {
		for (const packageName of ["protocol", "tools", "core", "tui", "cli"]) {
			await mkdir(join(rootPath, "packages", packageName, "src"), { recursive: true });
			await writeFile(join(rootPath, "packages", packageName, "package.json"), "{}");
		}
		await writeFile(join(rootPath, "packages", "tui", "src", "builtin.ts"), 'import { createHash } from "node:crypto";\nvoid createHash;\n');
		expect(await findViolations(new URL(`file://${rootPath}/`))).toEqual([]);
	} finally {
		await rm(rootPath, { recursive: true, force: true });
	}
});
