import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type MemoryFileSystem = Pick<typeof fs, "open" | "mkdir" | "lstat" | "realpath" | "readdir" | "rename" | "unlink" | "readFile" | "writeFile" | "copyFile">;
export const memoryFiles: MemoryFileSystem = fs;
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** One local process at a time; external editors are protected by revision checks. */
export async function memoryLock<T>(root: string, action: () => Promise<T>, signal?: AbortSignal, files = memoryFiles): Promise<T> {
	await files.mkdir(root, { recursive: true });
	const lock = join(root, ".forge-memory.lock");
	const recovery = join(root, ".forge-memory.recovery");
	const token = JSON.stringify({ pid: process.pid, id: randomUUID() });
	const deadline = Date.now() + 5000;
	const release = async (path: string) => {
		try { if (await files.readFile(path, "utf8") === token) await files.unlink(path); }
		catch (error) { if (!missing(error)) throw error; }
	};
	const ownerIsDead = (text: string): boolean => {
		let owner: unknown;
		try { owner = JSON.parse(text); } catch { return false; }
		const pid = typeof owner === "number" ? owner : owner && typeof owner === "object" && "pid" in owner ? owner.pid : undefined;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
		try { process.kill(pid, 0); return false; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	};
	let handle;
	while (!handle) {
		signal?.throwIfAborted();
		try {
			const acquired = await files.open(lock, "wx", 0o600);
			try { await acquired.writeFile(token); handle = acquired; }
			catch (error) { await acquired.close(); await files.unlink(lock); throw error; }
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (ownerIsDead(await files.readFile(lock, "utf8"))) {
					let guard;
					try { guard = await files.open(recovery, "wx", 0o600); }
					catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						if (ownerIsDead(await files.readFile(recovery, "utf8"))) throw new Error("Interrupted memory lock recovery; inspect the recovery lock before retrying");
					}
					if (guard) {
						try {
							await guard.writeFile(token);
							// Re-read under the recovery guard: another writer may now own the main lock.
							if (ownerIsDead(await files.readFile(lock, "utf8"))) await files.unlink(lock);
						} catch (error) { if (!missing(error)) throw error; }
						finally { await guard.close(); await release(recovery); }
						continue;
					}
				}
			} catch (readError) { if (!missing(readError)) throw readError; }
			if (Date.now() >= deadline) throw new Error("Memory scope is busy; retry after the current writer finishes");
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	}
	try { signal?.throwIfAborted(); return await action(); }
	finally { await handle.close(); await release(lock); }
}
