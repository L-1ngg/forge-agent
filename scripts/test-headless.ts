import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../packages/cli/src/main.ts";
import { modelResponse } from "../packages/core/test/helpers/model-response.ts";

const directory = await mkdtemp(join(tmpdir(), "forge-agent-headless-"));
let modelCalls = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => modelResponse([], "end_turn", ++modelCalls === 1 ? "replay ok" : '{"updates":[],"indexes":[]}') });
const previousCwd = process.cwd();
const previousDataHome = process.env.XDG_DATA_HOME;
const originalLog = console.log;
const lines: string[] = [];
try {
	process.chdir(directory);
	process.env.XDG_DATA_HOME = join(directory, "data");
	await mkdir(join(directory, ".forge-agent"));
	await Bun.write(join(directory, ".forge-agent/config.json"), JSON.stringify({ apiKey: "local-test", baseUrl: server.url.toString() }));
	console.log = (...args) => { lines.push(args.map(String).join(" ")); };
	const code = await main(
		["-p", "phase-1 smoke", "--json", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
	);
	if (code !== 0) throw new Error(`Headless CLI exited with code ${code}`);
	if (modelCalls !== 2) throw new Error(`Expected main and deferred memory calls, received ${modelCalls}`);
	const save = lines.map(line => JSON.parse(line) as { type?: string; phase?: string; status?: string }).find(event => event.type === "memory" && event.phase === "save");
	if (save?.status !== "skipped") throw new Error(`Unexpected deferred memory result: ${JSON.stringify(save)}`);
	for (const line of lines) originalLog(line);
} finally {
	console.log = originalLog;
	server.stop(true);
	process.chdir(previousCwd);
	if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = previousDataHome;
	await rm(directory, { recursive: true, force: true });
}
