import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../packages/cli/src/main.ts";
import { modelResponse } from "../packages/core/test/helpers/model-response.ts";

const directory = await mkdtemp(join(tmpdir(), "forge-agent-headless-"));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => modelResponse([], "end_turn", "replay ok") });
const previousCwd = process.cwd();
const previousDataHome = process.env.XDG_DATA_HOME;
try {
	process.chdir(directory);
	process.env.XDG_DATA_HOME = join(directory, "data");
	await mkdir(join(directory, ".forge-agent"));
	await Bun.write(join(directory, ".forge-agent/config.json"), JSON.stringify({ apiKey: "local-test", baseUrl: server.url.toString() }));
	const code = await main(
		["-p", "phase-1 smoke", "--json", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
	);
	if (code !== 0) throw new Error(`Headless CLI exited with code ${code}`);
} finally {
	server.stop(true);
	process.chdir(previousCwd);
	if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = previousDataHome;
	await rm(directory, { recursive: true, force: true });
}
