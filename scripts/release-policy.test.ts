import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertMasterAncestor, assertVersionAvailable, validateReleaseInput } from "./release-policy.ts";

const valid = { version: "v0.1.0-alpha.1", sha: "a".repeat(40), ref: "refs/heads/master" };

test("release inputs require a prerelease version, full SHA, and master dispatch", () => {
	expect(() => validateReleaseInput(valid)).not.toThrow();
	for (const version of ["", "v0.1.0", "v01.1.0-alpha.1", "v0.1.0-alpha.01", "v0.1.0-alpha.1\n", "$(exit 0)", "v0.1.0-alpha.1; echo unsafe"]) {
		expect(() => validateReleaseInput({ ...valid, version })).toThrow("Version");
	}
	for (const sha of ["master", "abc123", "A".repeat(40), `${valid.sha}\n`, `--${valid.sha}`]) {
		expect(() => validateReleaseInput({ ...valid, sha })).toThrow("SHA");
	}
	expect(() => validateReleaseInput({ ...valid, ref: "refs/heads/feature" })).toThrow("master");
});

test("release target must be in master history, not merely exist in the repository", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-agent-release-git-"));
	const git = async (...args: string[]) => {
		const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (code !== 0) throw new Error(error);
		return out.trim();
	};
	try {
		await git("init", "-q");
		await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base");
		const base = await git("rev-parse", "HEAD");
		await git("update-ref", "refs/remotes/origin/master", base);
		await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "unmerged");
		const unmerged = await git("rev-parse", "HEAD");
		await expect(assertMasterAncestor(base, cwd)).resolves.toBeUndefined();
		await expect(assertMasterAncestor(unmerged, cwd)).rejects.toThrow("origin/master");
		await expect(assertMasterAncestor("0".repeat(40), cwd)).rejects.toThrow("origin/master");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("existing tags and unpublished drafts block duplicate versions", async () => {
	await expect(assertVersionAvailable(valid.version, async () => Response.json({ ref: "tag" }))).rejects.toThrow("Tag already exists");
	await expect(assertVersionAvailable(valid.version, async (path) => path.startsWith("/git/")
		? new Response(null, { status: 404 })
		: Response.json([{ tag_name: valid.version, draft: true }]))).rejects.toThrow("Release already exists");
});

test("release lookup paginates and refuses API failures", async () => {
	await expect(assertVersionAvailable(valid.version, async (path) => {
		if (path.startsWith("/git/")) return new Response(null, { status: 404 });
		if (path.endsWith("page=1")) return Response.json(Array.from({ length: 100 }, (_, i) => ({ tag_name: `other-${i}` })));
		return Response.json([{ tag_name: valid.version }]);
	})).rejects.toThrow("Release already exists");
	await expect(assertVersionAvailable(valid.version, async () => new Response(null, { status: 403 }))).rejects.toThrow("HTTP 403");
	await expect(assertVersionAvailable(valid.version, async (path) => new Response(null, { status: path.startsWith("/git/") ? 404 : 500 }))).rejects.toThrow("HTTP 500");
	await expect(assertVersionAvailable(valid.version, async (path) => path.startsWith("/git/") ? new Response(null, { status: 404 }) : Response.json([]))).resolves.toBeUndefined();
});

test("publication depends on both validation and the complete platform matrix", async () => {
	const release = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/prerelease.yml", import.meta.url)).text()) as {
		permissions: { contents: string };
		jobs: Record<string, { needs?: string | string[]; if?: string; permissions?: { contents: string }; uses?: string; with?: { target?: string } }>;
	};
	const verify = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/verify.yml", import.meta.url)).text()) as {
		jobs: { check: { strategy: { matrix: { os: string[] }; "fail-fast": boolean }; steps: Array<{ run?: string }> } };
	};
	expect(release.permissions.contents).toBe("read");
	expect(release.jobs.verify?.needs).toBe("validate");
	expect(release.jobs.verify?.with?.target).toBe("${{ inputs.target_sha }}");
	expect(release.jobs.publish?.needs).toEqual(["validate", "verify"]);
	expect(release.jobs.publish?.if).toBeUndefined();
	expect(release.jobs.publish?.permissions?.contents).toBe("write");
	expect(verify.jobs.check.strategy.matrix.os).toEqual(["ubuntu-24.04", "macos-14"]);
	expect(verify.jobs.check.strategy["fail-fast"]).toBe(false);
	expect(verify.jobs.check.steps.map((step) => step.run).filter(Boolean)).toEqual([
		"bun install --frozen-lockfile", "bun run check", "bun run test:headless", "bun run typecheck:examples",
	]);
});
