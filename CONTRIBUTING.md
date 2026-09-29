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

`check` and `test:headless` use local fixtures, fake credentials, a restricted environment, and isolated configuration directories on both platforms. Linux additionally enforces OS network isolation inherited by CLI and tool subprocesses: it requires `unshare`, `ip`, and Python 3 for the independent native socket probe (unprivileged namespaces locally; CI can create the namespace with sudo then drop privileges). Missing Linux isolation support fails the check. macOS runs the full compatibility suite without OS network isolation, Seatbelt, or PF. `test:network` is Linux-only. Reports distinguish the platforms' evidence; this is not a filesystem or arbitrary-code sandbox.

Use `bun run test:contract`, `bun run test:integration`, and `bun run test:cli` for focused groups. `.test-results/` contains JUnit, raw failure traces, network evidence, and timings; CI uploads these even on failure. `bun test <file>` is useful for quick local work but does not supply OS isolation evidence. The [testing guide](docs/phases/testing-system-implementation.md) describes fixture maintenance, property replay, and the separately budgeted `test:live` probe. Do not use live credentials in ordinary tests or update fixtures automatically on a mismatch.

Do not include API keys, local configuration, or session history in issues, commits, logs, or screenshots. `.forge-agent/` is local runtime data.

## Scripts and Examples

`typecheck:automation` checks every `scripts/**/*.ts` entry, including script tests; `typecheck:tests` checks root `tests/**/*.ts`. Package checks cover their own source/tests, and `typecheck:examples` covers `examples/**/*.ts`. Type checking does not execute scripts. Test discovery and grouping remain in [test-offline.ts](scripts/test-offline.ts).

Run commands from the repository root. Choose an explicit output path for experiments; keep existing evidence unchanged.

| Entry | Purpose and external calls | Output |
|---|---|---|
| `bun run check`, focused tests, `bun run test:headless` | Dependency/type checks and local fixtures; no live model | Console and `.test-results/`; see Local Checks above |
| `bun run benchmark:resume` | Synthetic session list/preview benchmark; no model | JSON on stdout; synthetic sessions are removed |
| `bun scripts/context-notes-benchmark.ts` | Estimate fixed note/search material size; no model | JSON on stdout; no measured provider-token claim |
| `bun scripts/markdown-preview.ts` | Interactive Markdown sample; no model | Terminal only; no saved conversation |
| `bun run tui:frame dump --out /tmp/forge-frame.json` | Dump the idle TUI; `dump-scenarios` and `compare` cover cell fixtures | Explicit JSON path; golden files remain in `packages/tui/test/fixtures/golden/` |
| [Frozen context-selection replay](docs/research/context-selection/README.md#离线复算-v2) | Recompute historical v2 reports; no model or dependency installation; requires the recorded Git history | Explicit `--out`; temporary source/data copies are removed |
| [Compaction experiment](scripts/context-compaction-benchmark.ts), [selection experiment](scripts/context-selection-benchmark.ts), [memory experiment](scripts/memory-quality.ts) | Explicit live-model experiments with their own budgets; selection `--phase preflight` is local | Explicit `--out`; results belong to the exact runtime, runner and fixture version |
| `bun run test:live` | Budgeted real-provider probe; required variables and boundaries are in the [testing guide](docs/phases/testing-system-implementation.md) | Console report; never part of ordinary checks |
| [Source prerelease workflow](docs/release.md) | `release-policy.ts` checks Git/GitHub; `release-notes.ts` generates notes; remote draft creation is a manual workflow | Workflow logs and draft assets |

The current compaction and selection report scripts validate recordings made with their matching runner and sources. A command pointing at today's scripts does not reproduce a historical experiment automatically. Frozen snapshots and original data live under the relevant [research entry](docs/research/README.md); superseded implementation evidence is reached through the [archive](docs/archive/README.md). A nested manifest/lockfile in a research probe freezes its isolated environment and is not a workspace dependency declaration. Runtime patch versions and reasons are documented in the [model adapter contract](docs/phases/model-adapter.md).

| Example | Purpose | Model traffic and saved output |
|---|---|---|
| [sdk-quickstart.ts](examples/sdk-quickstart.ts) | Minimal SDK call used in the README | Live model; answer on stdout, in-memory session |
| [embedded-agent.ts](examples/embedded-agent.ts) | Custom tool, permission rule and host configuration | Live model; inspect the example's explicit tool before running |
| [custom-adapter.ts](examples/custom-adapter.ts), [turn-policy.ts](examples/turn-policy.ts), [context-transform.ts](examples/context-transform.ts) | Native adapter, stop policy and request projection | Offline scripted responses; stdout, no saved session |
| [scripted-adapter.ts](examples/scripted-adapter.ts) | Shared fixture for those offline examples | Helper module, not a standalone command |
| [mcp-client.ts](examples/mcp-client.ts) | Discover a supplied stdio server and read a resource | No model; starts the chosen server and prints its data |
| [context-acceptance.ts](examples/context-acceptance.ts) | Bounded compaction and reopen exercise | Live model; JSON summary on stdout, temporary sessions removed |

## Changes and Documentation

Keep changes focused. Preserve the protocol/core/tools/TUI boundaries and route model imports through the core adapter. Update English and Chinese README content together; update both SDK guides when the host contract changes. Internal planning and architecture decisions remain in Chinese, linked from [docs/README.md](docs/README.md).

The maintainer works directly on `master`; external contributors should use a branch and PR. CI checks pushes and pull requests. Maintainer review is sufficient; this project does not require a second reviewer or a formal approval meeting.

Report bugs with a minimal reproduction, commit, Bun version, OS, and terminal. Feature requests should describe the task and expected outcome, rather than assuming a particular implementation. Roadmap directions live in [docs/plan.md](docs/plan.md), not a separate task board.

Contributions are licensed under the repository's [MIT license](LICENSE). See [AGENTS.md](AGENTS.md) and [docs/SOP.md](docs/SOP.md) for the detailed internal workflow.

Maintainers create development snapshots through the [manual draft prerelease workflow](docs/release.md). It revalidates the selected commit on both platforms; normal pushes never publish a release.
