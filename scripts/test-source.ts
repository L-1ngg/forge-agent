import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

/** Includes dirty and untracked executable inputs; generated reports never identify source. */
export async function sourceIdentity(root: string): Promise<{ head: string; dirty: boolean; sha256: string; files: number }> {
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`Source identity: git ${args[0]} failed`);
		return result.stdout.toString();
	};
	const paths = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0"))]
		.filter(path => /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|lock|patch)$/.test(path)).sort();
	const hasher = new Bun.CryptoHasher("sha256");
	for (const path of paths) {
		hasher.update(path + "\0");
		const absolute = join(root, path);
		const stat = await lstat(absolute).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!stat) hasher.update("deleted\0");
		else { hasher.update(String(stat.mode) + "\0"); hasher.update(stat.isSymbolicLink() ? await readlink(absolute) : await Bun.file(absolute).arrayBuffer()); hasher.update("\0"); }
	}
	return { head: git("rev-parse", "HEAD").trim(), dirty: git("status", "--porcelain").length > 0, sha256: hasher.digest("hex"), files: paths.length };
}
