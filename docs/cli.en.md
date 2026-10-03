# CLI Guide

[简体中文](cli.md) · [Project README](../README.md) · [SDK guide](sdk.en.md)

This guide covers the terminal application and headless CLI. Start with the [quickstart](../README.md#quick-start) to install dependencies and configure a model. For embedding Forge in an application, use the SDK guide.

[Terminal](#use-the-terminal) · [Sessions](#sessions) · [JSON output](#headless-mode) · [Configuration](#configuration) · [Skills](#skills) · [MCP](#mcp-servers) · [Memory](#memory)

## Run in a Project

From the Forge checkout, start the terminal with `bun run forge-agent`. To work in a different project, change to that directory and invoke the source entrypoint by its absolute path:

```bash
cd /path/to/your-project
bun /path/to/forge-agent/packages/cli/src/main.ts
```

The current directory determines tool paths and project configuration. Session files and project Skills are grouped by Git worktree root, or by the startup directory outside Git. Configure provider credentials in the environment or your [user/project configuration](#configuration).

Run `bun run forge-agent --help` from the Forge checkout to see CLI options. The commands below assume that checkout; use the absolute entrypoint when working elsewhere.

## Use the Terminal

Type a task and press Enter. Forge streams the reply and shows tool calls, results, file diffs, and permission cards. Use `/help` for available commands. Type `@` to complete a file mention.

| Action | Key or command |
|---|---|
| Send a message, or queue it while a task runs | Enter in the input editor |
| Cancel the running task and send the current input after cleanup | Ctrl+Enter |
| Browse output or return to the input editor | Tab; follow the footer's current shortcuts |
| Scroll the transcript | PageUp/PageDown or the mouse wheel |
| Stop an active task when no card or other UI layer owns Esc | Esc |
| Exit | Ctrl+C or `/quit` |

Permission cards have their own focus and shortcuts. Esc can park a permission card so you can browse the transcript; `c` opens the input editor and Tab or `i` returns to the card. Follow the visible shortcuts when a picker, detail view, or form is open.

The TUI uses the terminal's alternate screen. Markdown replies render in both the transcript and detail view; narrow tables become labelled records, long code lines wrap, and copy actions preserve Markdown source. LaTeX remains literal. Clipboard delivery uses available native channels, with OSC 52 as a terminal-dependent fallback. You can try the rendering without a model or session with `bun scripts/markdown-preview.ts`.

## Sessions

Each launch starts a new conversation. Nothing is saved until the first input is consumed. Conversations then live under `.forge-agent/sessions/` at the Git worktree root, or the startup directory outside Git.

| Command | Effect |
|---|---|
| `/new` | Start an independent conversation with the current model, tools, and configuration |
| `/resume` | Browse and reopen this project's saved conversations |
| `/clear` | Clear the visible transcript while preserving the current model context |

In `/resume`, use Up/Down to select, Ctrl+E to expand recent user/assistant excerpts, and Enter to open the session. Esc collapses a preview, then closes the picker. Previews are bounded and may omit content; reopen the session to read its full history. Browsing does not call the model, write history, or interrupt the active task. Selecting another session does.

Starting or switching sessions during a task cancels it and waits for tool cleanup and saving. A save failure stops the switch. Tools must cooperate with cancellation. Restoring history never replays unfinished tools; pending approvals can resume only in the current process.

Unsent drafts and queued input from saved conversations remain in memory for this process. Returning to the session restores them as editable text without sending. To carry draft text through a switch, put `/new` or `/resume` on a separate first line. Discarding a draft in an empty conversation asks for confirmation. Drafts are not saved on exit.

A worktree and its subdirectories share session history; separate worktrees are isolated. Existing `.forge-agent/session.jsonl` files remain discoverable. There is no `--session` option or `sessionPath` configuration key. Damaged files require a verified copy through the [SDK conversion workflow](sdk.en.md#storage-and-commits) before reuse. JSONL saving does not guarantee atomicity under crashes or power loss.

## Headless Mode

Use `--json` with a prompt to run without the TUI. Stdout contains newline-delimited JSON events:

```bash
bun run forge-agent --json -p "Read package.json and summarize it"
```

`-p` alone does not select headless mode. There is no interactive approval in JSON mode: a request that needs a person receives a conservative rejection or cancellation, and the process reports a distinct exit code. Check the process exit code as well as the streamed events.

| Exit code | Meaning |
|---|---|
| `0` | Successful or deferred task completion |
| `1` | Startup/runtime failure or output-length termination |
| `2` | Invalid arguments or missing provider/model selection |
| `20` | Tool permission needed a person |
| `21` | Cancellation confirmation needed a person |
| `22` | A question needed a person |
| `23` | Plan approval needed a person |
| `24` | OAuth interaction required |
| `25` | MCP Elicitation required |
| `130` | Aborted task |

When a task produces several kinds of interactive request, the first such request determines its interaction exit code. SDK event and result semantics are documented in [Execution Results and Configuration](sdk.en.md#execution-results-and-configuration).

Management entrypoints include:

```bash
bun run forge-agent --json -p '/skills'
bun run forge-agent --json -p '/skills reload'
bun run forge-agent --memory 'list'
bun run forge-agent --mcp 'status'
```

Skills management makes no model calls or conversation history, but normal startup still requires provider/model credentials. Standalone memory file operations and MCP management do not need model credentials. MCP operations may connect to configured servers or require separate authorization. `--mcp 'use-prompt ...'` and `--mcp 'use-resource ...'` submit task input and do require a model.

## Configuration

Configuration is applied in this order, with later values taking precedence:

1. `~/.config/forge-agent/config.json`, or `$XDG_CONFIG_HOME/forge-agent/config.json` when set.
2. `.forge-agent/config.json` in the startup directory.
3. `FORGE_AGENT_PROVIDER`, `FORGE_AGENT_MODEL`, and `FORGE_AGENT_API_KEY`.
4. `--provider` and `--model` CLI flags for provider/model selection.

For example, a project can select a model while referencing a key stored in the environment:

```json
{
  "provider": "xai",
  "model": "grok-4.6",
  "apiKey": "$FORGE_AGENT_API_KEY"
}
```

If no explicit key is set, Forge can use the provider's native environment variable, such as `XAI_API_KEY` or `OPENAI_API_KEY`. Keys are case-sensitive; unknown top-level fields are rejected. Model IDs must be in the built-in catalog, and a compatible proxy must accept the selected model's protocol. Set `baseUrl` in JSON to use that proxy. Restart the CLI after changing its configuration file.

Common optional fields:

| Field | Purpose |
|---|---|
| `systemPrompt` | Main instructions for the agent |
| `thinkingLevel` | Requested reasoning level, subject to model support |
| `maxTokens` | Model output limit |
| `contextWindow` | Override the declared context window |
| `permissionMode` | `default`, `accept-edits`, or `deny-all`; see below |
| `cacheHints` | Add supported task cache parameters; defaults to `true` |
| `skills`, `mcp`, `memory`, `context` | Feature-specific configuration described below |

Task cache hints use a stable session key for xAI Responses and default ephemeral caching for Anthropic Messages. Set `cacheHints: false` if a compatible proxy rejects those parameters. It does not disable implicit provider caching, and Forge does not silently remove parameters and retry. Summaries and memory organizers receive no automatic task hints. See [Prompt cache](sdk.en.md#prompt-cache) for session identity, token accounting, and cache limits.

## Tool Permissions

The CLI automatically allows ordinary `read` calls. Otherwise, the default policy asks when no earlier rule decides the call. Approve or deny through the permission card; a refusal is returned to the model so it can adjust its work.

Set `permissionMode` in configuration:

| Mode | Behavior after earlier policy layers |
|---|---|
| `default` | Ask for a decision |
| `accept-edits` | Allow normal `write`/`edit` calls; other undecided calls still ask |
| `deny-all` | Deny undecided ordinary tool calls |

`deny-all` is not a sandbox or a universal tool-off switch: earlier approvals such as the CLI's built-in read rule still apply. Trusted Skills and memory tools run without interactive permission, including in this mode. Skill loading does not authorize shell commands or install dependencies. Tool side effects are not rolled back. See [SDK permissions](sdk.en.md#permissions) for the complete policy and approval contract.

## Skills

The CLI discovers directories containing `SKILL.md` in this order:

| Source | Default location |
|---|---|
| Project | `<project>/.forge/skills` |
| User | `~/.forge/skills` |
| Bundled | `packages/cli/builtin_skills` in the Forge checkout; currently empty |

Here, `<project>` is the Git worktree root or the startup directory outside Git. The first source wins when names collide. Missing default roots are empty; malformed entries are reported or skipped by discovery.

After adding a skill named `code-review`, use:

```text
/skills reload
/skills
/skill code-review Review this patch.
```

`/skill` offers name completion. Accept a name with Enter, then enter the task. It loads the body before submitting one user input; failed input returns to the draft. Headless invocation works with `--json -p '/skill code-review Review this patch.'`.

The model initially sees skill names and descriptions, then loads a body when needed. `disable-model-invocation: true` prevents automatic selection while allowing explicit `/skill` use. Skills can include resources under `references/` or `assets/`; loading a resource does not execute scripts, install dependencies, or grant permission through `allowed-tools`.

Use `--no-skills`, set `skills.enabled` to `false`, or override roots in JSON. Relative roots resolve from the startup directory; a missing explicit root is an error:

```json
{
  "skills": {
    "enabled": true,
    "roots": { "workspace": "./team-skills", "user": "/home/alice/shared-skills" }
  }
}
```

Reloaded Skills apply after the current run. The SDK requires explicit roots rather than CLI discovery; see [SDK Skills](sdk.en.md#skills) for host configuration and invocation.

## MCP Servers

Forge supports local stdio, remote Streamable HTTP, and legacy SSE servers. Add server definitions to user or project configuration; a project definition replaces the whole server with the same ID. Replace the example command and URL with your server's values:

```json
{
  "mcp": {
    "servers": {
      "files": { "transport": "stdio", "command": "your-mcp-server", "args": [] },
      "remote": { "transport": "http", "url": "https://example.com/mcp", "auth": { "type": "oauth", "scopes": ["read"] } }
    }
  }
}
```

```text
/mcp status
/mcp login remote
/mcp resources files
/mcp use-prompt files review --args '{"topic":"change"}' -- Review this change
```

`login` starts explicit browser authorization. `use-prompt` submits a server-provided Prompt and your task as context. Tools follow the permission policy. Resources, URI templates, Prompts, subscriptions, OAuth, and form/URL Elicitation are also available; see [SDK MCP](sdk.en.md#mcp) and the [catalog example](../examples/mcp-client.ts).

`--no-mcp` disables connections. To persist a change, run `bun run forge-agent --mcp 'disable files --scope project'`, or use `--scope user`. TUI enable/disable without a scope affects only the current Agent.

CLI OAuth credentials use the system credential store. Linux requires Secret Service by default. Explicitly selecting `mcp.credentialStore: "linux-keyutils"` uses the current Linux/WSL instance and may require login again after restart; there is no silent fallback. SDK credentials default to instance-local memory. External-service and platform coverage is documented in the [MCP acceptance record](phases/mcp-client-acceptance.md) (Chinese).

## Memory

Forge keeps preferences and project notes as ordinary Markdown topics with a short `MEMORY.md` index. The CLI recalls memory when a run starts and can make an additional model call after the task to organize useful notes. A failed organizer does not change the task result. Current instructions take precedence over saved notes; notes do not grant tool permissions.

Use `/memory` for help, active settings, and directory locations:

```text
/memory list
/memory save project workflow.md Use Bun for this project.
/memory read project workflow.md
/memory edit project workflow.md Use Bun for local development; production is undecided.
/memory pin project workflow.md
/memory sources project workflow.md
/memory delete project workflow.md
```

You can also edit the Markdown files directly. `search <scope> <words>` searches notes; `read <scope> <path> <offset>` continues from a returned `nextOffset`; `unpin` removes a pin. `import <session-path>` explicitly reads a bounded excerpt from one current-project conversation and asks the model to organize it. Startup never scans old sessions for memory.

Files live under `$XDG_DATA_HOME/forge-agent/memory`, defaulting to `~/.local/share/forge-agent/memory`, outside the checkout. User preferences and project notes have separate scopes. A new worktree copies the main worktree's project Markdown once and then evolves independently; Git merges do not synchronize these copies. Deleting a note does not delete session history.

Recall and deferred organization are independently enabled by default. To disable both persistently:

```json
{
  "memory": { "autoUpdate": false, "injection": false }
}
```

`/memory auto off` and `/memory inject off` affect only the current process and apply to the current Agent after its active run. Explicit memory management remains available with both off. `bun run forge-agent --memory 'read project workflow.md'` reads a saved note without a model.

The `memory` save event reports skipped, saved, or failed status and organizer usage when provided. Topic and index writes are independent. The SDK only enables memory when its host supplies a store; see [SDK memory](sdk.en.md#persistent-memory) for configuration and storage behavior.

## Context Management

Context compaction is enabled by default in the CLI and SDK. It keeps concise task notes and evidence references in model context while retaining full records in session history and checkpoints. The agent can search those records with `search_context` and retrieve original text with `read_context`; both follow the existing permission policy and never replay historical tools.

Use `/compact` to request compaction, optionally followed by instructions about what to retain. Configuration can explicitly enable or disable automatic compaction:

```json
{
  "context": { "enabled": true }
}
```

Task requests still pass the final input/output budget check when automatic compaction is disabled. Compaction and caching do not guarantee lower token usage or cost on every task. See [SDK context management](sdk.en.md#context-management) for limits and recovery, and [host context transformation](sdk.en.md#host-context-transformation) for application-controlled projection. Migration details and existing data formats are covered in the SDK guide.

## OpenTelemetry

To export traces, configure an OTLP endpoint before starting the CLI:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=forge-agent bun run forge-agent --json -p "Inspect this project"
```

The CLI uses OTLP HTTP/JSON. The general endpoint gets `/v1/traces` appended; `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` selects an exact URL. Standard OTLP headers/timeout and resource environment variables are supported; the service name defaults to `forge-agent`. Export is off without an endpoint, and `OTEL_SDK_DISABLED=true` disables it explicitly.

Content capture is off by default. `FORGE_OTEL_CAPTURE_CONTENT=true` includes prompts, replies, and tool arguments/results; exception messages can contain text even when capture is off. Normal exit waits for exporter shutdown. Export failures do not alter the task result or JSON stdout; forced termination may lose buffered spans.

The CLI exports traces only. SDK hosts can also supply a meter and redaction callbacks. See [SDK OpenTelemetry](sdk.en.md#opentelemetry) and the offline [OTel example](../examples/otel.ts).
