# Contributing to Forge Agent

Forge Agent is a personal project under active development. Issues and focused pull requests are welcome, but there is no response-time or compatibility commitment. Please discuss major features before implementing them.

## Local Checks

Use Bun 1.3.12 and the existing workspace toolchain:

```bash
bun install --frozen-lockfile
bun run check
bun run test:headless
bun run typecheck:examples
```

The test suite uses local provider replays and real PTYs. It does not require an API key. Keep regression tests with behavior changes, and include what you ran, what you did not run, why, and remaining risks in your PR.

Do not include API keys, local configuration, or session history in issues, commits, logs, or screenshots. `.forge-agent/` is local runtime data.

## Changes and Documentation

Keep changes focused. Preserve the protocol/core/tools/TUI boundaries and route model imports through the core adapter. Update English and Chinese README content together; update both SDK guides when the host contract changes. Internal planning and architecture decisions remain in Chinese, linked from [docs/README.md](docs/README.md).

The maintainer works directly on `master`; external contributors should use a branch and PR. CI checks pushes and pull requests. Maintainer review is sufficient; this project does not require a second reviewer or a formal approval meeting.

Report bugs with a minimal reproduction, commit, Bun version, OS, and terminal. Feature requests should describe the task and expected outcome, rather than assuming a particular implementation. Roadmap directions live in [docs/plan.md](docs/plan.md), not a separate task board.

Contributions are licensed under the repository's [MIT license](LICENSE). See [AGENTS.md](AGENTS.md) and [docs/SOP.md](docs/SOP.md) for the detailed internal workflow.

Maintainers create development snapshots through the [manual draft prerelease workflow](docs/release.md). It revalidates the selected commit on both platforms; normal pushes never publish a release.
