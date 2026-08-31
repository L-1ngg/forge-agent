import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../packages/cli/src/main.ts";
import { createPiTestPort } from "../packages/core/src/pi-port.ts";

const directory = await mkdtemp(join(tmpdir(), "myh-headless-"));
try {
	const code = await main(
		["-p", "phase-1 smoke", "--json", "--provider", "faux", "--model", "faux-1", "--session", join(directory, "session.jsonl")],
		async () => createPiTestPort({ responses: [{ text: "replay ok" }] }),
	);
	if (code !== 0) throw new Error(`Headless CLI exited with code ${code}`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
