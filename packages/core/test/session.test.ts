import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, loadConfig, resolveSecret, SessionSearch, SessionStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "myh-core-"));
	temporaryDirectories.push(path);
	return path;
}
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

test("session store appends valid v3 entries and branches in place", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const first = await store.appendTurn([
		{ role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: Date.now(), stopReason: "stop" },
	]);
	expect(first.every((entry) => /^[0-9a-f]{8}$/.test(entry.id))).toBe(true);
	expect(first[0]?.parentId).toBeNull();
	expect(first[1]?.parentId).toBe(first[0]?.id);

	store.branch(first[0]?.id ?? null);
	const branch = await store.appendTurn([{ role: "user", content: [{ type: "text", text: "branch" }], timestamp: Date.now() }]);
	expect(branch[0]?.parentId).toBe(first[0]?.id);
	expect(store.getTree()[0]?.children).toHaveLength(2);

	const reopened = await SessionStore.open(path, cwd);
	expect(reopened.getEntries()).toHaveLength(3);
});

test("session search locates and reads only matching entries", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const entries = await store.appendTurn([
		{ role: "user", content: [{ type: "text", text: "alpha decision" }], timestamp: Date.now() },
		{ role: "assistant", content: [{ type: "text", text: "beta" }], timestamp: Date.now() },
	]);
	const search = new SessionSearch(path);
	const first = entries[0];
	if (!first) throw new Error("Expected first session entry");
	expect(await search.search("DECISION")).toEqual([first.id]);
	expect((await search.readEntry(first.id))?.message.role).toBe("user");
});

test("agent runner does not persist an aborted or unpaired turn", async () => {
	const cwd = await temporaryDirectory();
	const path = join(cwd, "session.jsonl");
	const store = await SessionStore.open(path, cwd);
	const runner = new AgentRunner(
		{
			async *runTurn() {
				yield { type: "message_end", timestamp: 1, message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", arguments: {} }], timestamp: 1, stopReason: "aborted" } };
				yield { type: "turn_end", timestamp: 2, stopReason: "aborted" };
				yield { type: "agent_end", timestamp: 3 };
			},
			steer() {},
			followUp() {},
			abort() {},
		},
		store,
	);
	const events: unknown[] = [];
	for await (const event of runner.runTurn("abort me")) events.push(event);
	expect(events).toHaveLength(3);
	expect(store.getEntries()).toHaveLength(0);
});

describe("config", () => {
	test("merges global, project, and environment layers", async () => {
		const root = await temporaryDirectory();
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".config", "myh"), { recursive: true });
		await mkdir(join(cwd, ".myh"), { recursive: true });
		await writeFile(join(home, ".config", "myh", "config.json"), JSON.stringify({ provider: "global", model: "global-model" }));
		await writeFile(join(cwd, ".myh", "config.json"), JSON.stringify({ model: "project-model" }));
		const config = await loadConfig({ cwd, home, env: { MYH_PROVIDER: "env" } });
		expect(config).toMatchObject({ provider: "env", model: "project-model" });
	});

	test("resolves command and environment secrets", async () => {
		expect(await resolveSecret("!echo test-secret")).toBe("test-secret");
		expect(await resolveSecret("key-$TOKEN", { TOKEN: "value" })).toBe("key-value");
	});
});
