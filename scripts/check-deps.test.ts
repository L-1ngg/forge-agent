import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findViolations } from "./check-deps.ts";

test("dependency check rejects the replaced execution engine even inside the model adapter", async () => {
	const rootPath = await mkdtemp(join(tmpdir(), "myh-deps-engine-"));
	try {
		for (const packageName of ["protocol", "tools", "core", "tui", "cli"]) {
			await mkdir(join(rootPath, "packages", packageName, "src"), { recursive: true });
			await writeFile(join(rootPath, "packages", packageName, "package.json"), "{}");
		}
		const manifest = JSON.stringify({ dependencies: { "@earendil-works/pi-agent-core": "0.84.4" } });
		await writeFile(join(rootPath, "package.json"), manifest);
		await writeFile(join(rootPath, "packages", "core", "package.json"), manifest);
		await writeFile(join(rootPath, "packages", "core", "src", "pi-port.ts"), 'import "@earendil-works/pi-agent-core";\nexport * from "@earendil-works/pi-agent-core/agent-loop";\n');
		const violations = await findViolations(new URL(`file://${rootPath}/`));
		expect(violations).toContain("package.json must not depend on pi-agent-core");
		expect(violations).toContain("packages/core/package.json must not depend on pi-agent-core");
		expect(violations.filter((violation) => violation === "packages/core/src/pi-port.ts must not import pi-agent-core")).toHaveLength(2);
	} finally {
		await rm(rootPath, { recursive: true, force: true });
	}
});

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
		await writeFile(join(rootPath, "packages", "tui", "src", "forbidden.ts"), 'import "@earendil-works/pi-tui";\n');
		expect(await findViolations(new URL(`file://${rootPath}/`))).toContain("packages/tui/src/forbidden.ts has forbidden external import @earendil-works/pi-tui");
	} finally {
		await rm(rootPath, { recursive: true, force: true });
	}
});
