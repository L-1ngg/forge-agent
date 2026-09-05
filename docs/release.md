# Source Prereleases

Forge Agent releases are source snapshots of a personal project. Packages remain private; no npm packages or executable binaries are published. The maintainer pushes directly to `master`; CI runs after pushes and on PRs. Release validation runs independently against an exact commit.

## Create a Draft

1. Open GitHub Actions and select **Draft prerelease**.
2. Choose the **master** branch for the workflow, enter a new `vX.Y.Z-alpha.N` version (for example `v0.1.0-alpha.1`), and a full lowercase 40-character commit SHA from `master` history.
3. Wait for validation and both Ubuntu 24.04 / macOS 14 checks. The workflow creates a draft prerelease only after all checks succeed.
4. Review its source SHA, verification link, limitations, archive, and checksum. Publishing the draft is a separate manual action on GitHub; the workflow never publishes it automatically.

The equivalent CLI is `gh workflow run prerelease.yml --ref master -f version=VERSION -f target_sha=FULL_SHA`. Supply literal values for VERSION and FULL_SHA. Use the repository's GitHub Actions run page to follow progress.

## Verify the Download

Download the archive and `SHA256SUMS` from the draft (maintainer access is required). In their directory, run:

```bash
# Linux
sha256sum -c SHA256SUMS
# macOS
shasum -a 256 -c SHA256SUMS
```

Extract the archive, enter its directory, then run `bun install --frozen-lockfile` and `bun run test:headless` with Bun 1.3.12. Model credentials are not needed for this smoke test. Run `bun run forge-agent` only after supplying your own provider configuration. Archives contain tracked files from the verified commit, not local configuration, session history, node_modules, or build output.

## Failure and Retry

Invalid input, a target outside `master` history, an existing tag/draft/release, API lookup failures, or either platform's failed checks prevent publication. A release job rechecks availability before writing. A new push during a run does not change its target SHA. Workflow runs are serialized; they do not cancel an active prerelease to replace it.

GitHub may hide unpublished drafts from the read-only validation token. The write-scoped publication job repeats the check and rejects an existing draft before creating or uploading anything; in that case, the platform checks will have run before the duplicate is reported.

If asset upload fails after draft creation, the draft may be incomplete. Inspect it before taking action; a retry refuses to overwrite it. Remove an incomplete draft only after reviewing its state, or use a new version. The workflow does not delete drafts, replace tags, publish a stable release, or grant write access to verification jobs.

CI uses read-only tokens, Actions pinned to full commit SHAs, and local provider fixtures. Real-provider smoke tests and manual terminal acceptance remain separate. Internal delivery evidence is recorded in [GitHub delivery](phases/github-delivery.md) (Chinese).
