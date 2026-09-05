# Forge Agent

[![CI](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**A general-purpose single-agent framework, currently under personal development.**

Forge Agent combines a self-owned execution core, an embeddable Bun SDK, and a terminal application. Use the CLI for coding tasks, assemble tools and prompts through the SDK, or fork the project to build a specialized agent.

[简体中文](README.zh-CN.md) · [SDK guide](docs/sdk.en.md) · [Contributing](CONTRIBUTING.md)

## Current Capabilities

- **Owned execution loop:** model streaming, tool execution, permissions, invocation-scoped steering and follow-ups, cancellation, and session commits.
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

Configuration loads from `~/.config/forge-agent/config.json` (or `$XDG_CONFIG_HOME/forge-agent/config.json`), then `.forge-agent/config.json`, then `FORGE_AGENT_PROVIDER`, `FORGE_AGENT_MODEL`, and `FORGE_AGENT_API_KEY`. CLI flags override provider/model/session selection. A project configuration can reference an environment variable:

```json
{
  "provider": "xai",
  "model": "grok-4.6",
  "apiKey": "$FORGE_AGENT_API_KEY"
}
```

Optional `baseUrl` points the CLI at a compatible proxy. Keys are case-sensitive and unknown top-level fields are rejected. Sessions default to `.forge-agent/session.jsonl`; use `--session PATH` to select another file.

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

## Architecture

| Package | Responsibility |
|---|---|
| `@forge-agent/protocol` | Events, requests, responses, and presentation data |
| `@forge-agent/core` | ExecutionCore, model adapter, permissions, sessions, and SDK |
| `@forge-agent/tools` | Tool contracts and built-in coding tools |
| `@forge-agent/tui` | Cell compositor and terminal interaction; depends only on protocol and Node built-ins |
| `@forge-agent/cli` | Configuration, credentials, tool/storage assembly, and TUI/headless entrypoints |

The dependency gate keeps UI dependencies out of the core and restricts pi-ai imports to the model adapter. Team orchestration, message routing, and multi-agent dashboards belong to external host projects.

## Roadmap

| Horizon | Direction |
|---|---|
| **Now** | Validate the core and SDK in real tasks; establish the public repository and source prerelease workflow |
| **Next** | Tool and Skills extensions; source-traceable research and reports |
| **Later** | Context management, recovery, and long-task reliability; then service APIs and distribution |

The [development plan](docs/plan.md) (Chinese) is the source of truth for actionable work. These are directions, not release-date commitments.

## Development Status and Limits

This is a personal project under active development. APIs and configuration may change. Automated tests do not imply complete real-provider or manual terminal acceptance.

- Bun SDK only; no npm distribution, stable API guarantee, or process-level sandbox.
- Custom tools must cooperate with cancellation. Tool side effects are not rolled back.
- JSONL storage does not guarantee atomicity under power loss or partial writes. Once a commit starts, cancellation waits for it to settle.
- The TUI uses alt-screen. Mouse-wheel support and OSC 52 clipboard integration are not implemented.
- Source prereleases are development snapshots, not installable binaries or production releases.

## Development and Documentation

```bash
bun run check
bun run test:headless
```

[SDK guide](docs/sdk.en.md) · [中文 SDK 指南](docs/sdk.md) · [Contributing](CONTRIBUTING.md) · [Internal documentation](docs/README.md) (Chinese)

Design references: [pi](https://github.com/earendil-works/pi), [grok-build](https://github.com/xai-org/grok-build), and [clowder-ai](https://github.com/zts212653/clowder-ai). Their licenses apply to their own code; the local pi-ai patch retains upstream attribution.

## License

[MIT](LICENSE), copyright 2026 L1ngg.
