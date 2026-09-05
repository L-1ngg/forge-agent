export interface ReleaseInput {
	version: string;
	sha: string;
	ref: string;
}

export function validateReleaseInput(input: ReleaseInput): void {
	if (input.ref !== "refs/heads/master") throw new Error("Dispatch prereleases from master only");
	if (/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.exec(input.version)?.[0] !== input.version) {
		throw new Error("Version must have the form vX.Y.Z-alpha.N without leading zeroes");
	}
	if (input.sha.length !== 40 || !/^[0-9a-f]{40}$/.test(input.sha)) throw new Error("Target must be a full lowercase 40-character commit SHA");
}

export async function assertMasterAncestor(sha: string, cwd = process.cwd()): Promise<void> {
	const child = Bun.spawn(["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/master"], { cwd, stdout: "ignore", stderr: "ignore" });
	if (await child.exited !== 0) throw new Error("Target must be a commit in origin/master history");
}

type Request = (path: string) => Promise<Response>;

export async function assertVersionAvailable(version: string, request: Request): Promise<void> {
	const tag = await request(`/git/ref/tags/${encodeURIComponent(version)}`);
	if (tag.ok) throw new Error("Tag already exists; refusing to overwrite");
	if (tag.status !== 404) throw new Error(`Unable to check tags (HTTP ${tag.status})`);
	// The tag endpoint may not expose an unpublished draft; inspect releases too.
	for (let page = 1; ; page++) {
		const response = await request(`/releases?per_page=100&page=${page}`);
		if (!response.ok) throw new Error(`Unable to check releases (HTTP ${response.status})`);
		const releases: unknown = await response.json();
		if (!Array.isArray(releases)) throw new Error("Unexpected release list response");
		if (releases.some((release) => release.tag_name === version)) throw new Error("Release already exists; refusing to overwrite");
		if (releases.length < 100) return;
	}
}

if (import.meta.main) {
	const input = { version: process.env.RELEASE_VERSION ?? "", sha: process.env.TARGET_SHA ?? "", ref: process.env.GITHUB_REF ?? "" };
	validateReleaseInput(input);
	await assertMasterAncestor(input.sha);
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GH_TOKEN;
	if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error("GitHub repository and token are required");
	await assertVersionAvailable(input.version, (path) => fetch(`https://api.github.com/repos/${repository}${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
		signal: AbortSignal.timeout(30_000),
	}));
	console.log(`Validated ${input.version} at ${input.sha}`);
}
