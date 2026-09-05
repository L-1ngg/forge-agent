import { validateReleaseInput } from "./release-policy.ts";

const version = process.env.RELEASE_VERSION ?? "";
const sha = process.env.TARGET_SHA ?? "";
validateReleaseInput({ version, sha, ref: process.env.GITHUB_REF ?? "" });
const repository = process.env.GITHUB_REPOSITORY ?? "";
const runId = process.env.GITHUB_RUN_ID ?? "";
await Bun.write("RELEASE_NOTES.md", `# Forge Agent ${version}

Source snapshot of a personal project under active development. This is a draft prerelease, not an installable binary or a stable SDK release.

- Source commit: ${sha}
- Verification: https://github.com/${repository}/actions/runs/${runId}
- Checks: frozen install, dependency boundaries, workspace types, full tests including PTY/HTTP replay, headless smoke, and example types on Ubuntu 24.04 and macOS 14, using Bun 1.3.12.
- Assets: source archive and SHA256SUMS. Extract the archive, run \`bun install --frozen-lockfile\`, then \`bun run forge-agent\` with your own provider configuration.
- Packages remain private workspace packages. No npm distribution, Node.js/native Windows compatibility, or stable API guarantee.
- Real-provider/manual acceptance and long-task reliability remain incomplete. Tools must cooperate with cancellation; JSONL does not guarantee crash-safe transactions.

Verify the archive with \`sha256sum -c SHA256SUMS\` on Linux or \`shasum -a 256 -c SHA256SUMS\` on macOS. Publishing this draft is a separate maintainer action.
`);
