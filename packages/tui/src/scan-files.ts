export interface ScanFilesOptions {
	maxEntries?: number;
	maxDepth?: number;
}

/** Synchronous, prefix-filtered repository scan used by the interactive picker. */
export function scanFiles(cwd: string, prefix = "", options: ScanFilesOptions = {}): string[] {
	const normalizedPrefix = normalizePath(prefix);
	const maxEntries = normalizeLimit(options.maxEntries, 2_000);
	const maxDepth = normalizeLimit(options.maxDepth, 12);
	if (maxEntries === 0) return [];
	const candidates: string[] = [];

	// Bun.Glob keeps the UI package free of direct node:fs/path imports while
	// retaining the synchronous scan contract required by the picker.
	try {
		const glob = new Bun.Glob("**/*");
		for (const entry of glob.scanSync({ cwd, dot: true, onlyFiles: true })) {
			const relativePath = normalizePath(entry);
			const segments = relativePath.split("/").filter(Boolean);
			if (segments.some((segment) => segment === ".git" || segment === "node_modules")) continue;
			if (Math.max(0, segments.length - 1) > maxDepth) continue;
			candidates.push(relativePath);
		}
	} catch {
		return [];
	}
	const directories = directoryPrefixes(candidates);
	return candidates
		.filter((entry) => matchesPathPrefix(entry, normalizedPrefix, directories))
		.sort((left, right) => left.localeCompare(right))
		.slice(0, maxEntries);
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function directoryPrefixes(paths: readonly string[]): Set<string> {
	const directories = new Set<string>();
	for (const path of paths) {
		const segments = path.split("/").filter(Boolean);
		for (let index = 1; index < segments.length; index++) directories.add(segments.slice(0, index).join("/"));
	}
	return directories;
}

function matchesPathPrefix(path: string, prefix: string, directories: ReadonlySet<string>): boolean {
	if (!prefix || !path.startsWith(prefix)) return !prefix;
	if (path.length === prefix.length || prefix.endsWith("/")) return true;
	// A complete directory prefix must not bleed into a sibling such as src2;
	// partial file-name prefixes remain ordinary startsWith matches.
	return !directories.has(prefix) || path[prefix.length] === "/";
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new RangeError("file scan limit must be a non-negative finite number");
	return Math.floor(value);
}
