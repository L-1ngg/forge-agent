import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../packages/cli/src/main.ts";
import { createPiTestPort } from "../packages/core/src/pi-port.ts";

const directory = await mkdtemp(join(tmpdir(), "forge-agent-headless-"));
const previousCwd = process.cwd();
const previousDataHome = process.env.XDG_DATA_HOME;
try {
	process.chdir(directory);
	process.env.XDG_DATA_HOME = join(directory, "data");
	const code = await main(
		["-p", "phase-1 smoke", "--json", "--provider", "faux", "--model", "faux-1"],
		async () => createPiTestPort({ responses: [{ text: "replay ok" }] }),
	);
	if (code !== 0) throw new Error(`Headless CLI exited with code ${code}`);
} finally {
	process.chdir(previousCwd);
	if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = previousDataHome;
	await rm(directory, { recursive: true, force: true });
}
