import { LongTermMemory, initializeMemoryCopy, type MemoryFileSystem } from "@forge-agent/core/sdk";
import * as memoryFiles from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const memoryHash = (text: string) => createHash("sha256").update(text).digest("hex");

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
	const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
	const output = await new Response(child.stdout).text();
	return await child.exited === 0 ? output.trimEnd() : undefined;
}

/** CLI resolves identities; core only receives explicitly bound directories. */
export async function createMemoryHost(cwd: string, dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), files: MemoryFileSystem = memoryFiles) {
	const canonical = await files.realpath(cwd);
	const top = await git(canonical, "rev-parse", "--show-toplevel");
	const worktree = top ? await files.realpath(top) : canonical;
	const common = top ? await git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir") : undefined;
	const repository = common ? await files.realpath(common) : canonical;
	const listing = top ? await git(worktree, "worktree", "list", "--porcelain", "-z") : undefined;
	const mainPath = listing?.split("\0").find(line => line.startsWith("worktree "))?.slice(9);
	const main = mainPath ? await files.realpath(mainPath) : worktree;
	const base = resolve(dataHome, "forge-agent", "memory");
	const projectBase = join(base, "projects", memoryHash(repository));
	const root = join(projectBase, memoryHash(worktree));
	const source = join(projectBase, memoryHash(main));
	const memory = new LongTermMemory({ user: join(base, "user"), project: root }, files);
	await initializeMemoryCopy(root, source, files);
	return { memory, worktree, repository, main };
}
