import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { LongTermMemory } from "./store.ts";
import { memoryFiles, memoryLock, missing, type MemoryFileSystem } from "./files.ts";
import { randomUUID } from "node:crypto";

/** Explicit host operation: copy only Markdown, finish once, preserve existing files on retry. */
export async function initializeMemoryCopy(target: string, source?: string, files: MemoryFileSystem = memoryFiles): Promise<void> {
	new LongTermMemory({ project: target }, files); // Validate host binding before any filesystem mutation.
	try { if ((await files.lstat(target)).isSymbolicLink()) throw new Error("Memory copy root is a symlink"); }
	catch (error) { if (!missing(error)) throw error; }
	await memoryLock(target, async () => {
		const marker = join(target, ".initialized");
		try {
			if ((await files.lstat(marker)).isSymbolicLink()) throw new Error("Memory initialization marker is a symlink");
			const content = await files.readFile(marker, "utf8");
			if (content === "complete\n") return;
			if (!"complete\n".startsWith(content)) throw new Error("Invalid memory initialization marker");
			// A recognizable interrupted marker is retryable; existing Markdown stays intact.
		} catch (error) { if (!missing(error)) throw error; }
		if (source && source !== target) {
			const origin = new LongTermMemory({ project: source }, files);
			for (const path of await origin.list("project")) {
				await origin.read("project", path);
				const destination = join(target, path);
				let current = target;
				for (const part of path.split("/")) {
					current = join(current, part);
					try { if ((await files.lstat(current)).isSymbolicLink()) throw new Error("Memory copy target is a symlink"); }
					catch (error) { if (!missing(error)) throw error; }
				}
				await files.mkdir(dirname(destination), { recursive: true });
				try { await files.copyFile(join(source, path), destination, constants.COPYFILE_EXCL); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			}
		}
		const temporary = join(target, `.initialize-${randomUUID()}.tmp`);
		try { await files.writeFile(temporary, "complete\n", { flag: "wx", mode: 0o600 }); await files.rename(temporary, marker); }
		finally { await files.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
	}, undefined, files);
}
