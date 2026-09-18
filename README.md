# Forge Agent

[![CI](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**A general-purpose single-agent framework, currently under personal development.**

Forge Agent combines a self-owned execution core, an embeddable Bun SDK, and a terminal application. Use the CLI for coding tasks, assemble tools and prompts through the SDK, or fork the project to build a specialized agent.

[简体中文](README.zh-CN.md) · [SDK guide](docs/sdk.en.md) · [Contributing](CONTRIBUTING.md)

## Current Capabilities

- **Owned execution loop:** model streaming, tool execution, permissions, invocation-scoped steering and follow-ups, cancellation, and incremental v4 session persistence.
- **Long tasks:** automatic or manual context compaction and bounded overflow recovery; provides sourced task notes, branch history search, and original-text retrieval. Read/Bash provide bounded previews and temporary command logs.
- **Embeddable SDK:** independent instances with host-provided tools, prompts, permissions, and storage. CLI and SDK share the same execution path.
- **Coding CLI:** read, write, edit, and shell tools; interactive TUI or JSON event output for scripts.
- **Terminal interface:** streaming transcript, tool and diff views, permission cards, queued input, and a cell-based renderer.

Model transport and authentication use [pi-ai](https://github.com/earendil-works/pi). The execution loop and TUI renderer are owned by this project. Research and report generation are planned extensions, not completed features.

## Quick Start

Requirements: **Bun 1.3.12** and a model provider account. Automated validation targets Linux and macOS; native Windows and Node.js are not supported targets yet.

```bash
git clone https://github.com/L-1ngg/forge-agent.git
cd forge-agent
bun install --frozen-lockfile

# Example: xAI. Set the key in your shell environment before running.
export FORGE_AGENT_PROVIDER=xai
export FORGE_AGENT_MODEL=grok-4.6
bun run forge-agent
```

Set `FORGE_AGENT_API_KEY` through your environment or use the provider's native variable, such as `XAI_API_KEY`. Never commit credentials. Other models use the provider/model identifiers supported by pi-ai.

For headless JSON events:

```bash
bun run forge-agent -- -p "Read package.json and summarize it" --json
```

Configuration loads from `~/.config/forge-agent/config.json` (or `$XDG_CONFIG_HOME/forge-agent/config.json`), then `.forge-agent/config.json`, then `FORGE_AGENT_PROVIDER`, `FORGE_AGENT_MODEL`, and `FORGE_AGENT_API_KEY`. CLI flags override provider/model selection. A project configuration can reference an environment variable:

```json
{
  "provider": "xai",
  "model": "grok-4.6",
  "apiKey": "$FORGE_AGENT_API_KEY"
}
```

Optional `baseUrl` points the CLI at a compatible proxy. Keys are case-sensitive and unknown top-level fields are rejected. Each launch starts a new conversation. Nothing is saved until the first message is consumed; conversation files then live under `.forge-agent/sessions/` at the Git worktree root (or the launch directory outside Git). `--session` and the `sessionPath` config key have been removed; use `/resume` to reopen history.

- `/clear` clears the visible transcript and keeps the current model context, with an explicit notice.
- `/new` starts an independent conversation with the current model, tools and configuration. During a task it cancels and waits for tool/persistence cleanup before switching; a save failure stops the switch.
- `/resume` lists this project's conversations by recent activity, prioritizing the first question as the title alongside a short timestamp; textless sessions use a placeholder. Up/Down selects; `Ctrl+E` expands up to six recent user/assistant excerpts on demand; `PgUp/PgDn` or the mouse wheel scrolls. `Esc` collapses the preview, then exits the list; `Enter` resumes. Moving selection collapses the preview. Browsing and previewing make no model calls or session writes and do not interrupt a running task; selecting another conversation does.
- Each preview message contains up to 500 characters with an omission marker. Images use placeholders, and interrupted/failed replies retain status labels. Resume to read the full history. Unchanged list metadata and up to 20 previews in the current picker are cached in memory, checking file changes on subsequent requests; cold loading still depends on history size.
- A Git worktree and its subdirectories share history; separate worktrees are isolated. Existing default `.forge-agent/session.jsonl` files in the project remain discoverable and are never overwritten or automatically converted.
- Unsent text and queued input from saved conversations are kept in memory for this process. Returning to the conversation restores them as an editable draft, without sending. They are not saved on exit. To switch while retaining editor text, put `/new` or `/resume` on a separate first line; an empty conversation with a draft asks before discarding it (`y` confirms, `n` or Esc cancels).

Restoring a conversation rebuilds its history and model context; it does not replay interrupted tools. Tools must cooperate with cancellation; switching can wait for their cleanup. A damaged conversation is reported and requires a verified copy using the SDK conversion workflow before it can be resumed.

## Persistent Memory

Persistent memory uses ordinary Markdown topics and a short `MEMORY.md` index. The model can save useful preferences and lessons during a task, and reads details on demand. Current requests and authoritative project documents take precedence over notes; saved notes do not grant permission. Release evidence and the default-enable gate are tracked in the [implementation record](docs/phases/persistent-memory.md).

The CLI enables memory injection and automatic updates by default. You can disable them independently; `permissionMode: "deny-all"` blocks model writes and deletions while explicit management remains available.

Use `/memory` for help and directory locations. Examples:

```text
/memory list
/memory save project workflow.md Use Bun for this project.
/memory read project workflow.md
/memory edit project workflow.md Use Bun for local development; production is undecided.
/memory pin project workflow.md
/memory sources project workflow.md
/memory read project workflow.md
/memory delete project workflow.md
```

`edit` and `delete` use your last read version and reject intervening edits. Plain Markdown can also be edited in your editor. `search <scope> <words>` searches unindexed notes; `read <scope> <path> <offset>` continues a page using its `nextOffset`. `unpin` removes a pin. `import <session-path>` explicitly imports a bounded excerpt from one current-project conversation for model-assisted organization; startup never scans history for memory.

Files live under `$XDG_DATA_HOME/forge-agent/memory` (default `~/.local/share/forge-agent/memory`), outside the Git checkout. User preferences are separate from project notes. A new worktree copies the main worktree's project Markdown once, then evolves independently. Later edits, deletions and Git merges do not synchronize copies. Deleting a note does not delete session history.

`memory.autoUpdate` and `memory.injection` in configuration independently control model writes and automatic injection. `/memory auto off` and `/memory inject off` change those settings for the current process. Explicit `/memory` management remains available with both off. `--memory 'read project workflow.md'` works without a model; separate invocations can pass the returned version with `edit ... --version VERSION CONTENT` or `delete ... --version VERSION`. An oversized index can be saved successfully while only a bounded fragment is injected; pinned content that does not fit is reported. Topic and index commits are independent.

The SDK only uses memory when its host supplies `memory: { store: new LongTermMemory({ project: absoluteDirectory }) }`; see the [SDK guide](docs/sdk.en.md#persistent-memory).

## Context Management

CLI and SDK use context compaction by default, including short task notes, history search/read, and request budgets. No opt-in is required. The following optional configuration makes the defaults explicit:

```json
{
  "context": {
    "enabled": true
  }
}
```

SDK `createAgent` also uses context compaction when `context` is omitted or empty. Existing CLI processes must be restarted to load the new default and configuration. No model change is required.

Context compaction sends concise task states and evidence IDs to the model while retaining full evidence in session history and checkpoints. The model can use `search_context` to locate records in the current branch, then `read_context` to retrieve original text. Both tools follow existing permissions and never replay historical tools. Compaction enforces input/output budgets and bounded rebuild attempts. Old pi sessions reconstruct their model context from original branch history; failures do not silently fall back to pi. The old pi strategy and `context.strategy` selector have been removed.

Context compaction does not guarantee lower token use or cost for every task. The initial [real-model comparison](docs/phases/adaptive-context-compaction-acceptance.md) and the later [software checks and material-size estimates](docs/phases/context-notes-search.md) for short notes/search are separate evidence; the new projection has not yet received a fresh real-model quality and total-cost evaluation. See the [SDK context guide](docs/sdk.en.md#context-management) for settings, permissions, and compatibility.

## Embed an Agent

Packages are **private workspace packages**, not published npm packages. Inside this monorepo, declare `"@forge-agent/core": "workspace:*"` in the consuming package and import `@forge-agent/core/sdk`. Repository-root examples use relative imports:

```ts
import { createAgent } from "./packages/core/src/sdk.ts";

const agent = await createAgent({
  provider: "xai",
  model: "grok-4.6",
  ...(process.env.FORGE_AGENT_API_KEY ? { apiKey: process.env.FORGE_AGENT_API_KEY } : {}),
  systemPrompt: "Answer concisely.",
  cwd: process.cwd(),
});
try {
  for await (const event of agent.runTurn("Hello")) {
    if (event.type === "message_delta" && event.contentType === "text") {
      process.stdout.write(event.delta);
    }
  }
} finally {
  await agent.dispose();
}
```

The SDK starts with in-memory history and no coding tools. The [custom-tool example](examples/embedded-agent.ts) supplies an explicit tool and permission rule:

```bash
bun examples/embedded-agent.ts
```

This example reads `FORGE_AGENT_PROVIDER`, `FORGE_AGENT_MODEL`, and optional `FORGE_AGENT_API_KEY` / `FORGE_AGENT_BASE_URL`. See [storage, permission handling, and lifecycle](docs/sdk.en.md) before embedding it in a long-lived application.

Assistant replies render Markdown in both the transcript and detail view, including tables and code highlighting. Narrow tables switch to labelled records; long code lines wrap with a continuation marker. Forge copy actions preserve Markdown source. LaTeX remains literal. To try a fixed sample without a model or saved session, run `bun scripts/markdown-preview.ts`.

## Architecture

| Package | Responsibility |
|---|---|
| `@forge-agent/protocol` | Events, requests, responses, and presentation data |
| `@forge-agent/core` | Source-owned Agent runtime, model adapter, permissions, sessions, and SDK |
| `@forge-agent/tools` | Tool contracts and built-in coding tools |
| `@forge-agent/tui` | Cell compositor and terminal interaction; protocol, Node built-ins, and pure Markdown/highlighting dependencies |
| `@forge-agent/cli` | Configuration, credentials, tool/storage assembly, and TUI/headless entrypoints |

The dependency gate keeps UI dependencies out of the core and restricts pi-ai imports to the model adapter, event projection, and source-owned runtime. Team orchestration, message routing, and multi-agent dashboards belong to external host projects.

The execution runtime is maintained in this repository, derived from the fixed Pi Agent source recorded in [runtime provenance](packages/core/src/runtime/README.md). Forge owns the session policies, SDK, CLI and TUI. The SDK supports `continue()`, invocation results, awaited idle/disposal, native text/image tool results, transient task retries, and controlled configuration updates; see the [SDK guide](docs/sdk.en.md).

## Roadmap

| Horizon | Direction |
|---|---|
| **Now** | Validate the core and SDK in real tasks and resolve remaining acceptance gaps |
| **Next** | Tool and Skills extensions; source-traceable research and reports |
| **Later** | Further validation of long-task reliability, recovery, and context quality/cost; then service APIs and distribution |

The [development plan](docs/plan.md) (Chinese) is the source of truth for actionable work. These are directions, not release-date commitments.

## Development Status and Limits

This is a personal project under active development. APIs and configuration may change. Automated tests do not imply complete real-provider or manual terminal acceptance.

- Bun SDK only; no npm distribution, stable API guarantee, or process-level sandbox.
- Custom tools must cooperate with cancellation. Tool side effects are not rolled back.
- JSONL storage does not guarantee atomicity under power loss or partial writes. Once a commit starts, cancellation waits for it to settle.
- The TUI uses alt-screen and supports mouse-wheel interaction. Clipboard delivery prefers available native channels; OSC 52 is a terminal-dependent fallback with no delivery guarantee.
- Source prereleases are development snapshots, not installable binaries or production releases.

## Development and Documentation

```bash
bun run check
bun run test:headless
bun run typecheck:examples
```

`check` uses local fixtures, fake credentials, and isolated configuration on both platforms. Linux additionally enforces OS network isolation with `unshare` and `ip`, and needs Python 3 for native network probes. macOS runs the full compatibility suite without OS network isolation or firewall setup. `test:network` is Linux-only. Use `test:contract`, `test:integration`, or `test:cli` for individual groups. Reports and timings, including the isolation mode, are written to `.test-results/`. The opt-in `test:live` probe requires an explicit target and request/time budgets; see the [testing guide](docs/phases/testing-system-implementation.md) (Chinese).

[SDK guide](docs/sdk.en.md) · [中文 SDK 指南](docs/sdk.md) · [Contributing](CONTRIBUTING.md) · [Internal documentation](docs/README.md) (Chinese)

Maintainers can create [source prerelease drafts](docs/release.md) after dual-platform verification. Publishing a draft is a separate manual step.

Design references: [pi](https://github.com/earendil-works/pi) and [grok-build](https://github.com/xai-org/grok-build). Their licenses apply to their own code; the local pi-ai patch retains upstream attribution.

## License

[MIT](LICENSE), copyright 2026 L1ngg.
