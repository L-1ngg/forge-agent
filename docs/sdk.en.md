# Embedding Forge Agent

[简体中文](sdk.md) · [Project README](../README.md)

The SDK is a private Bun workspace package, exported at `@forge-agent/core/sdk`. It is not published on npm and does not promise Node.js compatibility or process isolation.

## Native TanStack Model Adapters

The SDK accepts TanStack's native `AnyTextAdapter` and exports the equivalent `ModelAdapter` type. Forge's `Model` describes identity, protocol, capacity, and pricing; the adapter owns provider requests and streaming. A complete model object requires an adapter. Catalog string models can omit it and use built-in authentication and routing.

```ts
import { createAgent, type Model, type ModelAdapter } from "@forge-agent/core/sdk";

async function openAgent(model: Model, adapter: ModelAdapter) {
  return createAgent({ model, adapter, cwd: process.cwd(), systemPrompt: "Help with the task." });
}
```

Create an adapter with a TanStack provider factory, or implement `chatStream(request): AsyncIterable<AdapterYieldChunk>`. Requests use TanStack's `model`, `messages`, `systemPrompts`, `tools`, and `modelOptions`; the cancellation signal is `request.request.signal`. Forge maps output limits and reasoning from `Model.api` to provider-native options: Responses uses `max_output_tokens` and `reasoning.effort`, while Anthropic uses `max_tokens` and `thinking`. Keep the adapter's model and protocol aligned with its metadata. An explicitly supplied `provider` must match `model.provider`.

Custom adapters own credentials, endpoints, and headers. Forge supplies `sessionId` as the native `request.threadId` for both task and summary requests; it does not inject `apiKey` or `baseUrl` through the removed stream-options object. Catalog string models may also supply an adapter, bypassing built-in authentication checks. Built-in clients disable transport retries; custom clients should also disable their own retries so Forge's bounded session retry controls request counts and budgets.

Task requests and compaction summaries share the same applied adapter. Summaries have a separate system prompt, messages, and output budget, without task tools. Do not implement an adapter that can only return ordinary task answers. Asynchronous initialization can happen inside `async *chatStream()` and must honor the request signal. Finish complete responses with `RUN_FINISHED` and a `finishReason` of `stop`, `tool_calls`, or `length`. Emit `RUN_ERROR` for failures and `code: "aborted"` for cancellation. Incomplete streams, unknown finish reasons, and invalid tool JSON fail; truncated tools never execute.

For a provider that supports a deferred terminal response, emit `RUN_FINISHED` with `finishReason: "stop"` and `metadata: { forge: { stopReason: "deferred" } }`. This is an explicit Forge extension; ordinary TanStack interrupts do not imply provider deferral. The current invocation ends without background polling. Native `TokenUsage.cost` supplies reported cost for custom adapters; missing usage or cost remains unknown. Built-in catalog transports retain Forge's catalog pricing calculation.

`updateConfiguration({ model, adapter })` changes both after the current complete tool batch or summary, preserving accepted/applied receipts. Model metadata is snapshotted before asynchronous preparation; the host owns adapter objects and their closures. When changing models, also supply an adapter configured for the new model. Set `adapter: null` to restore the catalog adapter, using a string model; when switching from a model object, also supply provider/model. Failed updates preserve the applied configuration. Adapters are not persisted in session history.

This migration removes `StreamFn`, `AssistantMessageEventStream`, and Pi model event types without compatibility wrappers. Replace `{ model, streamFn }` with `{ model, adapter }` and emit native TanStack chunks. JavaScript callers also receive an explicit error for the removed `streamFn` option. Existing JSONL sessions, Markdown memory, and MCP attachments require no format conversion for this migration.

Use `CreateAgentOptions` for configuration; the synonymous `AgentOptions` export is removed. `SessionStore` implements `SessionStorage` directly, so replace `storage: store.asStorage()` with `storage: store`. Tool hook contexts use `SessionMessage`/`ToolCallBlock`. Authorization and execution share the final argument values; hosts influence the batch through the documented argument and result hooks.

Run the offline examples with `bun examples/custom-adapter.ts`, `bun examples/turn-policy.ts`, and `bun examples/context-transform.ts`. They use the native adapter in [scripted-adapter.ts](../examples/scripted-adapter.ts) without credentials. See [custom-adapter.ts](../examples/custom-adapter.ts) for a complete SDK call.

## Execution Responsibilities

SDK, CLI, and TUI share `createAgent → AgentSession → TanStack chat() → TextAdapter`. TanStack `chat()` owns model and tool continuation; the local Pi Agent and agent-loop are removed. Forge retains input ownership, configuration revisions, authoritative settlement, incremental persistence, and evidence-based compaction. Request-boundary `onConfig` middleware prepares the projection and final budget.

Tools enter through native `toolDefinition().server()`. Forge prepares and strictly validates arguments before approval, decides policy per call, and shows only `ask` decisions. Complete tool proposals and final arguments are appended before any tool side effect. TanStack owns interrupt/resume and serial execution; Forge persists each result before the next model request. TanStack's current `ModelMessage` aggregates successful response content. Forge checks the raw provider protocol, preserves continuation signatures, and projects it into `SessionMessage`. A final answer without tools is appended once at run completion; failures and cancellation retain partial output. `SessionMessage` remains the history and display contract. TanStack working messages and middleware metadata are not a second recoverable session store. See [ADR-027](decisions/027-native-tool-approval-and-interruption.md) and [ADR-028](decisions/028-model-response-boundary.md).

## Stop After a Completed Round (shouldStopAfterTurn)

Set `shouldStopAfterTurn(context, signal)` at creation to stop gracefully after a complete batch and avoid further model calls. Return a boolean synchronously or asynchronously: `true` stops the invocation; `false` allows it to continue. The SDK exports `ShouldStopAfterTurn`, `ShouldStopAfterTurnContext`, and `InvocationUsage`. Run the offline [turn-policy.ts example](../examples/turn-policy.ts) with `bun examples/turn-policy.ts`.

```ts
const agent = await createAgent({
  model, adapter, cwd: process.cwd(), systemPrompt: "Find the requested record.",
  tools, permission,
  shouldStopAfterTurn: ({ toolResults, turnIndex, usage }) => {
    const found = toolResults.some(result => result.toolName === "lookup" && !result.isError);
    const budgetReached = usage.costUsd !== null && usage.costUsd >= 0.10;
    return found || budgetReached || turnIndex >= 5;
  },
});
```

The callback runs after the assistant response, the complete tool batch, and required persistence, before consuming another steering/follow-up input. Normal responses without tools also invoke it. `turnIndex` starts at 1 for each `runTurn()` / `continue()` invocation. Failed retries, summaries, and error/aborted/length/deferred responses neither count as completed rounds nor invoke the callback.

`message` and `toolResults` use the SessionMessage protocol, including tool content and details. Arguments are isolated, deeply readonly snapshots, without mutable AgentContext access. `model` and `configurationRevision` describe the completed task request (initial revision 0), even when turn_end has already applied a new configuration. The accepted/applied timing stays intact. The callback is configured only at creation; `updateConfiguration` rejects it. The host owns closures; callbacks are not serialized.

`usage` totals this invocation's task requests, failed retries, and automatic summary requests, excluding historical usage and separate manual compaction. Fields are `requests`, `tokens` (input/output/cacheRead/cacheWrite/totalTokens), `costUsd`, `missingUsageRequests`, and `missingCostRequests`. If any request lacks valid token usage, tokens is null; if any request lacks usage or cost, costUsd is null. All-zero placeholder usage is conservatively unknown; positive token usage with an explicit zero cost remains 0. Costs use transport reports or Forge catalog pricing; unknown pricing is not inferred. The host decides whether unknown values should continue, stop, or fail; the example retains a round limit. Checking after a batch provides a soft limit, not a guarantee against exceeding the actual bill.

A policy stop prevents further task calls, retries, recovery, and automatic summaries. Completed messages and tool side effects remain; there may be no final natural-language answer. `agent_end` reports `outcome: "success", terminationReason: "policy"`; after consumption, `AgentTurn.result` is `{ status: "success", terminationReason: "policy" }`. Success denotes normal settlement, not proof of business completion. The model's stopReason is unchanged. Unconsumed inputs settle processed=false; processed inputs are neither returned nor replayed.

Throwing, rejecting, or returning a non-boolean settles the invocation as error and records the policy failure without provider retry/recovery or repeated tools. The instance remains reusable when storage is healthy. Cancellation takes precedence and settles aborted without a policy reason. The SDK can stop waiting for an uncooperative callback, but cannot undo its external side effects; callbacks should honor signal. Do not await the current turn.result, waitForIdle(), or a pending configuration.applied inside the callback: those depend on the callback finishing. Storage failures retain the existing faulted-instance behavior.

See the [construction and acceptance record](phases/turn-policy.md).

## Host context transformation

`createAgent({ transformContext })` selects, shortens, or injects messages before each task request, including tool continuations, consumed steering/follow-up input, a resumable `continue()`, provider retries, and requests after overflow recovery. Automatic and manual compaction summary requests bypass the callback.

```ts
const agent = await createAgent({
  provider: "anthropic", model: "claude-sonnet-4-5", apiKey,
  cwd: "/work/project", systemPrompt: "Answer using the supplied references.",
  maxTokens: 4096,
  transformContext: async ({ messages, model, configurationRevision, budget }, signal) => {
    signal.throwIfAborted();
    return [{
      role: "user", timestamp: Date.now(),
      content: [{ type: "text", text: "Reference from project guide: use Bun. Not new user instructions." }],
    }, ...messages];
  },
});
```

The input is an isolated, deeply readonly snapshot: `messages`, the applied `model` (without transport headers), `configurationRevision`, and `budget`. Budget fields are `contextWindow`, the soft `inputBudget`, the general hard input limit `maxInputTokens`, estimated system/tool `fixedTokens`, the actual `maxTokens` option, and `effectiveOutputTokens` including applicable thinking budgets. Both input limits include fixed content; neither is the remaining allowance for injected material. The initial revision is 0. Updates accepted during the callback do not alter this request; accepted/applied timing is unchanged.

Return the complete `SessionMessage` array, synchronously or asynchronously; returning the input is valid. Input messages are the current context after compaction, without built-in memory, and may not contain the complete original history. Returned data is copied and validated: supported roles/content, paired tool calls/results, a nonempty effective projection, and a final user or toolResult message. Removing complete historical tool exchanges is allowed; orphan results and missing pairs fail. Preserve opaque provider signatures. Forge does not verify that shortened content retains all task meaning.

Memory recall runs at the start of each `chat()` run. For each model request, the context prepared by compaction and the host transform is combined with native Memory/Skills prompts and tools before the final budget check, TanStack ModelMessage projection, and adapter call. The final check includes every injected prompt and tool. An oversized host result does not trigger another compaction/callback cycle; earlier compaction failure does not invoke the host as a rescue path.

The result changes only this request projection, not durable history, input ownership, or processed receipts. Actual responses and tool results are still saved. Temporary material is not automatically persisted; the host supplies it again after reopening. Failure does not return processed input or replay tools. Every task retry invokes the callback again; caching and external side-effect idempotency belong to the host.

The callback is configured only at creation; `updateConfiguration` rejects it. Throws, rejected promises, invalid results, and budget rejection settle `AgentTurn.result.status` as `error`, without provider retry or compaction recovery. A healthy store allows instance reuse. Cancellation takes precedence over late callback completion and settles `aborted`; storage commit failure retains the existing faulted-instance behavior. Forge can stop waiting for an uncooperative promise, but cannot stop its external work or synchronous blocking code. There is no automatic callback timeout: a host timeout error is an error; invocation cancellation is aborted. Do not await the current result, waitForIdle, or configuration.applied that depends on this invocation finishing from inside the callback.

Final checks also apply to task requests without a callback or with automatic compaction disabled:

```text
soft inputBudget = contextWindow - max(reserveTokens,
  effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))
hard maxInputTokens = contextWindow - effectiveOutputTokens - 1024
estimated final input > hard maxInputTokens → reject; do not reduce maxTokens
```

Input is estimated from the final messages, system prompt, and tool schemas. Historical assistant usage is omitted from model messages; stored history and actual usage totals are unchanged. Tool details are not counted as model input. With a host callback, historical provider usage anchors are not reused for transformed projections. Once preparation finishes, `getUsage()` reports the final estimate with `contextEstimated: true`; message/configuration changes invalidate it and restore the history preparation view.

Supported built-in TanStack transports use Forge's general hard limit. Internal rewrites and limits in a custom adapter remain the host's responsibility. Explicit `maxTokens > model.maxTokens` is rejected at creation/configuration validation; a failed update retains the applied configuration.

These are heuristic checks. The 1024-token margin is not an upper bound on Chinese text or image estimation errors, and provider overflow can still occur. Existing bounded recovery remains; no exact physical-window, answer-quality, or cost-saving guarantee is made. Run the offline [context-transform.ts example](../examples/context-transform.ts); design and evidence are in the [implementation plan](phases/context-transform.md).

## Skills

Omitting `skills` disables discovery. A configuration object enables it by default; `enabled: false` performs no scan. Core never discovers the host's home directory. Relative paths resolve against `cwd`; `~` is not expanded.

```ts
const agent = await createAgent({
  provider: "anthropic", model: "claude-sonnet-4-5", apiKey,
  cwd: "/work/project", systemPrompt: "Help with the task.",
  skills: { roots: {
    workspace: { path: "./skills" },
    user: { path: "/data/alice/skills", optional: true },
  } },
});
const snapshot = agent.getSkills();
const turn = agent.runTurn({ kind: "skill", name: "code-review", task: "Review this patch.\nKeep the API stable." });
for await (const event of turn) {
  if (event.type === "skill_input") console.error(event.inputId, event.code, event.message);
}
await turn.result;
const receipt = await agent.refreshSkills();
await receipt.applied;
```

`SkillsOptions.roots` uses workspace/user/builtin order; the CLI maps these to project, personal, and currently empty bundled directories. Missing layers are empty; missing roots are empty only with `optional: true`. Official `skillDirectory` handles discovery and validation; `aggregate`/`dedupe` use first-wins name resolution. `getSkills()` returns a copy of applied state with available and shadowed entries, their sources, and explicit-only flags, without bodies. `disable-model-invocation: true` hides a skill from automatic selection but permits explicit `/skill` use.

`withSkills` establishes the official catalog, `load_skill`, and activation deduplication for each `chat()` run. `createResourceTool` registers `read_skill_resource` for paths allowed by the official Source under `references/` or `assets/`. Both use Forge's common tool batch, hooks, AbortSignal, and session history. Their registered origin marks them internal/trusted, so they do not prompt for approval; a host tool with the same name is rejected during assembly. Official tools never execute scripts; scripts still require ordinary bash tools and permission.

`runTurn`, `steer`, and `followUp` accept `AgentInput = string | SkillInvocation`. Explicit selection loads through the same Source and expands the body plus literal task into one user message at consumption. It does not fabricate a model tool call or prompt for permission. `AgentTurn.inputId` and accepted receipts' `inputId` correlate rejection events; `skill_input` carries phase=`rejected`, name, code, and message. A rejected queued input settles processed=false, and an initial rejection returns an error result without faulting the instance. Hosts should retain original input to restore drafts.

Explicit input error codes include `skills-disabled`, `unknown-skill`, `too-large`, `invalid-skill`, `read-failed`, and `canceled`. The final request limit counts full input, the official catalog prompt, and tool definitions, even when automatic compaction is disabled.

`refreshSkills()` and `updateConfiguration({ skills })` share the configuration queue. New sources apply after the current `chat()` run; accepted does not mean applied. `updateConfiguration({ skills: false })` disables the feature. Preparation failures preserve old state; disposal cancels unapplied receipts. Later runs can reload a skill after context compaction, while saved history remains unchanged.

## Persistent Memory

The optional `memory` capability is supplied explicitly by the host. Omitting it reads no CLI memory directories and creates no memory files.

```ts
import { LongTermMemory, createAgent } from "@forge-agent/core/sdk";

const memory = {
  store: new LongTermMemory({ user: "/data/alice/memory", project: "/data/alice/project-a" }),
  autoUpdate: true,
  injection: true,
};
// Include memory in your existing createAgent({ provider, model, cwd, systemPrompt, ... }) options.
```

Roots must be explicitly authorized, normalized absolute paths. Model arguments only select provided user/project aliases and relative `.md` paths; frontmatter never determines scope. The SDK does not discover Git repositories. Hosts may call `initializeMemoryCopy(target, source?)` to copy only Markdown once; completion is recorded last, and retries preserve existing files. `MemoryFileSystem` supports injected file operations for failure testing and normally need not be supplied.

`store.read(scope, path, offset?, limit?)` returns a text page, modification time, sources, and warnings. Offsets are zero-based Unicode characters; pages contain at most 4096 characters. `search(scope, query, limit?)` performs case-insensitive literal all-word matching, including unindexed notes, and returns at most 10 snippets of 256 characters. Files are limited to 256 KiB and scans to 1000 directory entries/8 MiB. Plain Markdown needs no metadata; malformed optional metadata produces warnings without modifying the original. Source pointers are unverified and their history may be unavailable.

`store.write({ scope, path, content }, source)` writes ordinary Markdown. The host supplies actual source information `{ kind: "management" | "session", timestamp, sessionId?, entryId?, location? }`; the implementation appends the actual scope/root. `delete(scope, path)` removes a note; `pin(scope, path, enabled)` and `pinned(scope)` manage pinned paths. Only a completed write returns `saved: true`. There is no read-version, operation-ID, or idempotent-receipt protocol.

Topics and indexes are written directly and independently, without a multi-file transaction, file lock, concurrent-editor merge, or crash-recovery protocol. A memory tool error remains a tool error; JSONL commit failure still faults the agent. Deleting a note neither deletes JSONL nor erases original text already present in the current conversation.

At run start, `memoryMiddleware` calls the Markdown adapter's `recall`, which injects bounded indexes and pinned notes labeled by scope and path. Topics remain available through tools. After a successful run, its official deferred `save` makes one additional structured model call using the current model configuration, reads bounded linked topics, and writes planned topics and index updates. Content with no long-term value writes nothing. An organizer failure appears in the `memory` event without changing the successful task result. The save event reports `calls` and provider `usage` when available. Local file storage does not imply an offline model call.

The `read_memory/search_memory/write_memory/delete_memory` tools use Zod schemas and the common tool batch, hooks, cancellation, and events. As internal/trusted tools they do not prompt for approval. `autoUpdate: false` only disables deferred organization; explicit management tools and host store operations remain available. `injection: false` only disables run-start recall. Hosts change these settings through `updateConfiguration({ memory })`, which applies after an active `chat()` run completes.

CLI `/memory` directly manages Markdown without model permission. `permissionMode: "deny-all"` does not change silent execution of internal memory tools; ordinary file and shell tools still follow policy.

Recalled material is reference content, never a user instruction or permission. Full system prompts, messages, and tool definitions pass the final input-limit check after middleware injection. An explicit write within a run is visible through its tool result; the next run recalls current files from disk.

## Assembly and Customization Boundaries

`createAgent(options)` always assembles the production session and accepts exactly one options argument. Customize models through `model` + `adapter`, databases or session persistence through `storage` implementing `SessionStorage`, and tools through `tools`. Neither the SDK nor the CLI offers a factory for replacing the execution instance. The former second argument is rejected by TypeScript and throws a `TypeError` in JavaScript before any assembly or model invocation.

Creation calls `storage.load()` once and passes that state into the single `AgentSession`, including for default memory storage. There is no second assembly load or `setStorage` interface. A load failure prevents model requests and writes, preserving the original error. Later assembly failure disposes allocated MCP resources. An internally created RequestBus is closed; an externally supplied bus is not closed by failed assembly. If cleanup also fails, an `AggregateError` retains the original error in `cause` and `errors[0]`.

SDK integration tests control model responses through native TanStack adapters, with storage failures and tool behavior injected through `storage` and `tools`. Local UI/headless tests may keep their smaller interfaces, and unit tests may exercise internal modules directly. See the [foundation design](phases/tanstack-foundation.md) and [verification record](phases/tanstack-foundation-acceptance.md) (Chinese).

## Create an Instance

In a consuming workspace package, declare `"@forge-agent/core": "workspace:*"`. Then use:

```ts
import { createAgent } from "@forge-agent/core/sdk";

const agent = await createAgent({
  provider: "xai",
  model: "grok-4.6",
  ...(process.env.FORGE_AGENT_API_KEY ? { apiKey: process.env.FORGE_AGENT_API_KEY } : {}),
  systemPrompt: "Answer the user's questions concisely.",
  cwd: process.cwd(),
});
try {
  for await (const event of agent.runTurn("Hello")) {
    console.log(event);
  }
} finally {
  await agent.dispose();
}
```

For a runnable repository-root example, use [embedded-agent.ts](../examples/embedded-agent.ts), which imports the SDK by relative path and supplies a tool with no external side effects:

```bash
export FORGE_AGENT_PROVIDER=xai
export FORGE_AGENT_MODEL=grok-4.6
# Set FORGE_AGENT_API_KEY, or the provider's native key, in your environment.
bun examples/embedded-agent.ts
```

The host chooses where configuration comes from. The SDK does not read `.forge-agent/config.json`, expand `$ENV_VAR`, or execute `!command` secrets. Pass an already-resolved `apiKey`; if it is omitted, the model adapter may use provider-native credentials. The SDK does not install coding tools or a coding prompt. The CLI assembles those separately.

`FORGE_AGENT_BASE_URL` is read only by the example host and passed as `baseUrl`; it is not an automatically recognized SDK or CLI configuration variable. The CLI uses the `baseUrl` JSON field. The CLI additionally supports environment references and `!command` values for its `apiKey` field.

## Storage and Commits

Each instance defaults to independent memory storage. Hosts may implement the types exported by `@forge-agent/core/sdk`:

```ts
import type { SessionState, SessionEntry } from "@forge-agent/core/sdk";

interface SessionStorage {
  load(): Promise<SessionState>;
  append(entry: SessionEntry): Promise<void>;
}
```

`SessionState` contains all entries and the selected leafId. v4 records carry stable id, parentId and timestamp fields with an original message or separate compaction. The core allocates identities and appends serially: consumed user inputs before model requests, terminal assistant messages before tools, and settled tool results in call order before the next request.

Cancellation retains formed records and waits for started writes and tools. It does not roll back the invocation. Error and aborted assistant records remain inspectable but are filtered from future requests. Complete historical calls lacking results receive a request-only error stating that execution and side effects are unknown; they are never replayed.

A successful append must be reloadable. A write failure stops new scheduling and faults the instance. Inspect actual storage before recreating it; do not blindly retry a potentially partial append or allow concurrent writers. JSONL has no power-loss or partial-write transaction guarantee. External tool effects are never rolled back.

`SessionStore.create(path, cwd, id?)` synchronously prepares new file storage without writing. Its first `append()` creates the directories and exclusively writes the header and first entry. `load()` does not create a file. `saved` becomes `true` after successfully creating or opening the file; it is not a live existence check. `SessionStore.open(path, cwd)` still creates a missing file immediately by default; use `{ create: false }` when resuming. A first-write collision or I/O failure faults the instance without overwriting or automatically retrying. Omitting `id` generates an identity; pass `store.header.id` as `createAgent`'s `sessionId` to retain that routing identity.

The CLI uses v4 `SessionStore` instances as its storage. Older formats require a separate converted copy. Neither `processed` nor `message_end` acknowledges durability; normal iterator completion awaits all necessary writes.

`SessionStore.open` accepts `create: false` for discovery and resume validation without creating missing files. `store.appendable` indicates whether in-place appends are allowed; a false value requires a verified copy before continuing. CLI session selection does not change the SDK's custom `storage` or `sessionId` support; `--session` and `sessionPath` are no longer CLI entry points.

## Context Management

Context compaction provides sourced short notes, deterministic recent-history selection, bounded lookup, and request budgeting. The old pi strategy and `context.strategy` selector have been removed; supplying that field fails. Omitting `context` or passing `{}` enables the current policy. See [ADR-018](decisions/018-adaptive-default.md) and [ADR-023](decisions/023-deterministic-context-selection.md).

CLI configuration and SDK creation accept `context: { enabled, reserveTokens, keepRecentTokens, summaryReasoning }`, defaulting to `true`, `16384`, `20000`, and `"inherit"`. Update these settings while idle with `configureContext`. Search and retrieval still require host permission; enabling compaction does not grant access.

### States and Budgets

Context compaction protects unarchived user input, the latest user message, and the last complete interaction. It first clips recoverable old tool bodies. If clipping alone makes all interactions fit the input budget while shrinking the projection, all are retained; otherwise, optional originals are retained consecutively from newest to oldest until the next interaction exceeds `keepRecentTokens` or the input budget. Older messages are not reselected by term overlap, checkpoint source, or duplicate content. When unarchived material must be omitted, the task model extracts separate states and summary claims with exact saved-message references. Replacements require later user evidence; assistant statements are conservatively classified as inference. Recorded tool outcomes remain the execution evidence. Checkpoints never authorize tools, and structural validation does not prove semantic completeness.

Context compaction task requests use short checkpoint notes: state/claim kind, full text, and deduplicated source entryIds. Full quotes, state IDs, and replacement relationships remain in persisted checkpoints and the fallback summary; the execution ledger is retained. Summary generation still extracts full evidence, so this does not imply lower summary-generation cost.

Each compaction operation allows at most two logical generations and four actual model requests, including transient retries. The fourth incremental update, a task change, an invalid checkpoint or lack of progress can trigger rebuilding from original records. Oversized summary input, protected context that cannot fit, invalid references, and final lack of progress fail without publishing an invalid checkpoint. Automatic failure prevents that over-budget task request; cancellation and storage failures retain their existing lifecycle contracts.

Without an explicit task `maxTokens`, context compaction sends `min(4096, model.maxTokens)`. Its budget includes system text, tool definitions, states, summaries and messages, reserving `max(reserveTokens, effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))`. Effective output includes additional provider thinking budgets where applicable. Heuristic counts do not guarantee the physical provider window will fit. Summary input is checked separately and its output is capped at 4096 tokens, further limited by model capacity and the declared window.

### Search and Read History

Context compaction registers the reserved `read_context` tool through existing permission checks and tool hooks. It reads only saved messages in the selected session branch; a conflicting host tool name is rejected. Arguments are `entryId`, `offset` (default 0) and `limit` (default/maximum 4096), measured in Unicode code points. Text is capped at 16 KiB; `nextOffset` supports continuing long single lines. Metadata also counts toward subsequent context. Images return placeholders, and content never saved by the original tool cannot be recovered. Missing, out-of-range, and off-branch references fail explicitly. Hosts wanting automatic retrieval must allow this tool using their existing permission configuration.

The reserved `search_context` tool finds saved messages within the current branch when an entryId is unknown. Supply `query` (1–200 Unicode code points, at most 8 whitespace-separated literal words, all must match, case-insensitive), optional `role` (`user`, `assistant`, `toolResult`), and `limit` (default 5, maximum 10). Results are newest first by branch order, with `entryId`, `role`, `isError`, Unicode `offset`, a preview of at most 256 code points, and a `hasMore` flag. Use `read_context` for full text. This is literal search, not semantic interpretation of the latest decision. To avoid recursive echoes, search excludes results from either retrieval tool and assistant messages containing their calls; those records remain readable by ID. Search uses the same permissions, hooks and cancellation boundary, adds no model dependency, and never accesses other branches, sessions or files. Its schema and retrieved text add input overhead, so net token savings are workload-dependent.

### Compatibility and Events

Versioned optional `checkpoint` payloads extend v4 compaction records; the SDK exports `CompactionCheckpoint`. Reopening validates references and state replacement transitions. Readers convert the former v4 `adaptive` field to `checkpoint` without rewriting the original file; new records only write `checkpoint`. Records containing both fields are rejected, and the former SDK type alias is not retained. Histories without checkpoints reconstruct model context from original branch messages. Old pi summaries are not reused, and budget/extraction failures do not silently fall back to pi. Disabling automatic compaction does not remove the lookup tools or disable manual compaction. The [recent-selection verification record](phases/context-selection-simplification.md) covers the software contract; the separate [model-quality evaluation](phases/context-selection-evaluation.md) reports the bounded A/B result.

`compaction` events provide `action`, `inputBudget`, `contextEstimated`, `modelCalls`, `generations`, `elapsedMs`, `stopReason`, and aggregate `usage`; `strategy` is no longer emitted. These are cumulative snapshots: use the latest event per `operationId`, rather than adding snapshots.

See the [follow-up validation record](phases/context-notes-search.md) for the current short projection and cost-estimation limits. The initial context compaction holdout does not establish quality for the new projection.

### Automatic Compaction and Recovery

Before each task request, context exceeding the input budget triggers compaction; failure blocks that request. Overflow and eligible length responses share one recovery per continuous failure chain. Failed records remain saved, completed tools are never replayed, and successful answers are never regenerated just because usage reports overflow. `enabled: false` disables automatic compaction and recovery while preserving manual compaction and history lookup.

Summaries use the task model and routing with an isolated system prompt and no task tool definitions; built-in summary requests do not add task cache hints. `summaryReasoning: "off"` disables reasoning where supported, otherwise it inherits. Transient retries and at most two logical generations share a four-request cap. Provider errors stop after the retry policy settles and do not trigger checkpoint rebuilds.

Ordinary output-limit `length` text remains in subsequent requests; truncated tool calls are neither executed nor projected. A `length` attempt classified for context recovery stores `contextExcluded`, retaining its raw record while excluding it after reopening. Headless returns success after successful recovery, 1 for unrecovered error/length, and 130 for cancellation.

### Shared APIs and Accounting

`contextWindow` optionally overrides the local capacity declaration, defaulting to model metadata. Lowering it tests triggering, not physical provider overflow. `maxTokens` controls ordinary task output independently of compaction reserve; when omitted, it uses the explicit output reservation above. `getUsage().contextEstimated` distinguishes measured usage from estimation. Model, system, tool, branch and projection changes invalidate prior anchors; summary usage never anchors task context.

Historical user/toolResult content may include `{ type: "image", data: base64, mimeType }`. Requests retain the image, estimation counts 1024 tokens per image, and summaries serialize a placeholder. `sessionId` is generated per instance by default, may be supplied by the host, and comes from the session header in the CLI. Custom adapters read the same identity from `request.threadId` for tasks and summaries; hosts supply the stable `sessionId` again when reopening an instance. Built-in TanStack transports replay full history; Responses requests set `store: false` and do not use `sessionId` for server-side continuation. Models requiring `mistral-conversations` or `openai-codex-responses` are absent from the built-in catalog; hosts can supply a complete model object with a native adapter supporting the required protocol.

`await agent.compact(instructions?, onEvent?)` aborts active work, waits for tool and persistence cleanup, then compacts once without resuming the task. It returns `{ status, operationId, beforeTokens, afterTokens?, error? }`, with status `complete`, `skipped` or `error`. Storage faults still throw and disable the instance. Abort interrupts summaries and retry waits but waits for started writes. Instructions only focus the history summary.

Task streams and manual onEvent callbacks expose `compaction` phases (start, attempt, retry, end, error, skipped) and `recovery` events with operation identity, reason, estimates, attempts and usage. Attempt events report effective reasoning and any fallback. The TUI command is `/compact [instructions]`.

## File and Command Output

Read uses one-based `offset` and optional line-count `limit`, returning at most 2000 lines/50 KiB from the head, plus nextOffset or an oversized-line hint. It still reads the full file before slicing. Bash combines stdout/stderr in capture order and retains a 2000-line/50 KiB tail. Large output spills lazily to a complete system temporary log; logPath can be opened with ordinary Read. Failure, timeout and cancellation retain available output. Log I/O failure terminates the command and explicitly marks the capture incomplete.

Logs have no quota, TTL, exit deletion or automatic scan; the system or user manages their lifetime. A missing log is an ordinary read error and does not prevent session loading. Custom tools own truncation and continuation; the core does not redistribute a batch output budget. Preview limits exclude additional status and path metadata.

Use `SessionStore.convertCopy(source, target, cwd, options?)` to explicitly convert v3 to a distinct v4 file, refusing an existing target. The same entry point creates appendable copies of damaged or non-newline-terminated files. Open's onDiagnostic callback reports malformed JSON lines; leafId selects a branch. Uninterpretable selected chains or compaction boundaries are rejected. Roll back with preserved old data and a matching binary; disabling automatic compaction does not restore format compatibility.

Run `bun examples/context-acceptance.ts` for bounded live-provider acceptance using explicit host configuration. It limits experimental calls and duration and removes its temporary session.

## Events, Input, and Lifecycle

`runTurn(input)` returns a single-consumer async iterable with a readonly `id: symbol`. Each instance runs one invocation at a time; concurrent execution is rejected rather than queued. Multiple instances can run independently.

`steer(input, turn.id)` and `followUp(input, turn.id)` target the active invocation's separate FIFO queues. They return `{ accepted: false }` if execution has not started, has ended, is cancelling, or the ID is stale. A disposed or faulted instance throws. Hosts must retain input until its receipt resolves.

Creation options `steeringMode` and `followUpMode` independently select `"all"` or `"one-at-a-time"` (default). `all` drains that queue at its consumption point; `one-at-a-time` takes one entry. Steering takes priority over follow-up.

An accepted input returns `{ accepted: true, processed: Promise<boolean> }`. `true` means the input entered model context; `false` means it remained unprocessed when execution ended. Processing does not guarantee successful model completion or storage commit. Do not automatically resend processed input, which could repeat tool effects. Consume events concurrently with waiting on receipts; awaiting a future receipt inside the event loop can prevent the loop from advancing.

Cross-invocation queuing belongs to the host. The TUI displays a FIFO queue; Up on an empty composer recalls its tail, Esc stops automatic continuation and restores drafts, and Ctrl+Enter replaces the active task after cleanup. Commit failures pause queued input. `agent_end` only signals execution termination: the async iterable must finish normally before the host can treat persistence as complete.

Breaking out of the loop or closing the iterator while execution is active cancels and awaits cleanup. Once execution has settled, closing or disposing preserves its actual outcome and policy termination reason; a host rendering error thrown at `agent_end` also does not change the execution result. `abort()` handles an acquired iterator that has not started: later consumption cannot launch a model request, tool, or commit. After cleanup, the instance can be reused. Background execution still needs a host continuously consuming the event stream; UI subscribers can observe forwarded events.

`dispose()` is idempotent, refuses new work, and awaits cancellation cleanup or an already-started commit. Always await it, including when holding an unfinished iterator. Custom tools must cooperate with `AbortSignal`; an uncooperative tool can delay cancellation or disposal indefinitely. The SDK cannot forcibly terminate code in its own process.

## Permissions

Each ordinary model tool call is checked against the existing policy using its final arguments. `allow` is approved automatically, `deny` is rejected automatically, and only `ask` reaches the host through a native TanStack `needsApproval` interrupt. The batch resumes when every pending request has a valid answer; approved tools execute serially. A denied call returns its reason to the model so it can adjust its plan. Aborting the invocation invalidates its pending batch and old responses. Supply `permission.rules`, or consume `agent.requests` concurrently with `runTurn()` and answer through `agent.respond(...)`. Never wait for the execution loop to finish before handling its permission request.

For a permission request, respond with its exact ID and one of these result shapes:

```ts
agent.respond({ type: "response", id: request.id, result: { decision: "allow_once" } });
agent.respond({ type: "response", id: request.id, result: { decision: "deny", reason: "Host policy" } });
```

Choose one result after checking `request.kind === "permission"` and consulting the host's user or policy. Persistent approval uses `allow_always` with a typed scope derived from the exact tool call by `permissionScopeForToolCall` in `@forge-agent/protocol`; only offer it when the request permits remembering a rule. The example's narrow allow rule avoids interactive prompts for its single marker tool; it is not a recommendation to allow arbitrary tools.

An `allow_once` response may include `editedArgs: { ... }`. The SDK strictly validates and rechecks policy for edited arguments; invalid or denied edits do not execute. The displayed arguments, policy decision, and execution use the final values, which are saved as `toolArguments` on the tool result. Approval can resume only in the current process. Reopening a session retains its history but never replays unfinished tools. In the TUI, park a permission card with Esc, press `c` to draft or queue input, and use Tab or `i` to return to the card. Headless mode denies calls that require a person.

Unanswered requests default to denial after 30 seconds. Having no UI does not grant permission. Instances have independent permission memory and request buses by default. The CLI passes an exclusive bus and allows interactive users to wait without a timeout. Disposal closes the instance's bus, including a host-supplied one; do not share that bus across instances.

The host should stop its request-consumer task when disposal closes the stream and propagate consumer failures by aborting execution. Observation, responses, and release do not require pi types.

## Validation Boundaries

Automated tests use local HTTP providers, native adapter fixtures, tool and storage fault injection, controlled interleavings, and PTY interaction. They do not establish a stable public API, full real-provider coverage, long-task reliability, or filesystem crash consistency. The current migration's Ran / Not run / Why / Risk evidence is in the [verification record](phases/tanstack-foundation-acceptance.md) (Chinese). Historical acceptance of the previous implementation does not establish acceptance of this execution path.

## Execution Results and Configuration

The package name and `createAgent` remain unchanged. `AgentSession` implements the SDK directly, while TanStack `chat()` runs model and tool continuation. `HostedAgent`, `AgentPort`, `session-port`, and the local Pi runtime are removed. Hosts continue to use SDK input, tool, storage, and configuration interfaces.

```ts
const turn = agent.runTurn("Complete the task");
for await (const event of turn) {
  // Display or forward events; do not await the unfinished turn.result here.
}
const result = await turn.result;
await agent.waitForIdle();
// result.status: success | error | aborted | length | deferred

const continuation = agent.continue(); // Existing context, no additional user message
for await (const event of continuation) { /* Display events */ }
```

`turn.result` settles after consumption and required persistence. `waitForIdle()` waits for the currently acquired iterator and manual compaction to settle; it does not indicate model success. When manual compaction replaces active execution, the wait covers the complete compaction operation rather than ending as soon as the old iterator closes. `agent_end.outcome` reports the final session outcome; an intermediate error during retry is not the final failure. `deferred` is terminal, with no background polling. Consume the lazy stream, or acquire and close its iterator; an unconsumed stream starts no work.

Custom tools now return one structured result shape. The previous `{ ok, value, error }` shape is no longer the execute protocol:

```ts
import type { HarnessTool } from "@forge-agent/core/sdk";

const lookup: HarnessTool<{ key: string }, { source: string }> = {
  name: "lookup", label: "Lookup", description: "Look up a key",
  parameters: {
    type: "object", properties: { key: { type: "string" } },
    required: ["key"], additionalProperties: false,
  },
  async execute({ key }, context) {
    context.signal?.throwIfAborted();
    context.onUpdate?.({ content: [{ type: "text", text: "Looking up" }], details: undefined });
    return { content: [{ type: "text", text: key }], details: { source: "local" } };
  },
};
```

`content` contains model-visible text/images. `details` is independently persisted for host display and must support JSON persistence and snapshotting. Return `isError: true` or throw for failures; the model can then continue. Use `abort()` to stop the invocation. Progress uses the same result shape; updates after settlement are ignored. `prepareArguments` may synchronously normalize model input; `toolInputRewrites` may rewrite asynchronously. The `parameters` JSON Schema strictly checks types, required fields and extra fields; a numeric string is not converted to a number. Host `validateArguments` runs after the initial JSON Schema check, and its output must also match the schema. Initial validation, rewriting, before hooks, final validation, and authorization finish in call order before effects start. Once pending approvals are resolved, TanStack executes approved tools serially and Forge persists each result before the next tool starts. `beforeToolCall` returns block/reason; `afterToolCall` may override content/details/isError. Hooks use `SessionMessage` for assistantMessage/context.messages and `ToolCallBlock` (`type: "tool_call"`) for toolCall. Authorization, execution, and after hooks observe the same final arguments. Failed preparation skips that effect. The former `wrapTool` helper has been removed; use `toolInputRewrites` for input changes and SDK permissions for authorization.

Task and summary retries share `retry` settings but have independent counters. Transient task failures retry three times by default, after 2/4/8 seconds. Original errors remain in history and are excluded from retry requests. Consumed input and completed tool results are reused without duplicate user messages or tool replay. Overflow uses the separate single context recovery allowance, not ordinary retry. `retry` events report scheduled/attempt/end; cancellation interrupts the wait.

```ts
const receipt = await agent.updateConfiguration({
  systemPrompt: "Updated instructions",
  thinkingLevel: "low",
  tools: [lookup],
});
// receipt.accepted === true does not mean the current response uses the update.
const application = await receipt.applied;
// application.status: applied | canceled; revision matches the receipt.
```

Updates support provider/model/adapter/apiKey/baseUrl/systemPrompt/thinkingLevel/tools/maxTokens/contextWindow/skills/mcp. Asynchronous validation failure rejects the update and preserves the previous configuration. Idle updates apply immediately. During a response, approval wait, or tool execution, the complete proposed batch retains its configuration; the update applies before the next model request. Manual summaries finish before updates apply. No extra model request is made solely to apply a configuration. Disposal or storage faults cancel pending updates. Await `applied` outside the event consumption loop. Tool schemas are snapshotted before acceptance; callback closures remain host-owned. Applying an update invalidates the current usage anchor while preserving historical last-call counters.

See the [foundation design](phases/tanstack-foundation.md) for responsibility changes, migration and rollback, and the [verification record](phases/tanstack-foundation-acceptance.md) for actual results (Chinese).

## MCP

`createAgent({ mcp })` explicitly enables MCP; the SDK never reads host configuration files. `mcp: false` prevents connections. Each Agent owns its connections, catalogs, interactions, and cancellation scope, using the official `@modelcontextprotocol/client@2.0.0`. Run the catalog/read-only example without model requests:

```sh
bun examples/mcp-client.ts bun packages/core/test/helpers/mcp-server.ts
```

```ts
const agent = await createAgent({
  provider, model, apiKey, cwd,
  mcp: {
    servers: {
      local: { transport: "stdio", command: "your-mcp-server", args: [] },
      remote: {
        transport: "http", url: "https://example.com/mcp",
        auth: { type: "oauth", scopes: ["read"] },
      },
    },
    // Inject credentials, artifacts, and interaction host adapters here.
  },
});
try {
  console.log(agent.mcp.snapshot());
  const receipt = await agent.mcp.refresh();
  await receipt.applied; // Wait outside the turn event consumer.
} finally { await agent.dispose(); }
```

Server definitions accept command/args/cwd/env for `stdio`, url/headers for `http` or `sse`, plus enabled, protocol (stdio/SSE default `legacy`, HTTP defaults to `auto`, or pin `2026-07-28`), auth, tools.include/exclude, and timeouts. env/header values expand `$VAR` or `${VAR}` without running a shell; a missing variable fails only that server. OAuth and an Authorization header are mutually exclusive. SDK relative cwd resolves against the host cwd; CLI cwd resolves against its source configuration file. Default timeouts are 15 seconds for connect/request, 60 seconds for tool, 300 seconds for total/interaction, and 5 seconds for cleanup; total must be at least tool. Partial startup failures appear in the snapshot while healthy servers remain usable.

`agent.mcp` exposes snapshot/subscribe, refresh/reconnect/setEnabled, login/logout, listResources/listResourceTemplates/listPrompts/complete, readResource/getPrompt, subscribeResource/unsubscribeResource/readArtifact. Configuration changes return `ConfigurationReceipt` and apply after the current model response and entire tool batch. `updateConfiguration({ mcp })` replaces pure configuration; adapters can only be supplied at creation. Tools capture their original definition and outputSchema, so notifications cannot change validation during execution. Connection loss or timeouts never trigger business-call replay; recovery is for subsequent requests. Resource updates emit events without modifying history. Reconnect restores subscriptions when the identity is unchanged and the URI remains available; late notifications after unsubscribe are ignored.

Resource reads, Prompt retrieval, subscriptions, attachments, and tools use the existing permission checks. Remote annotations never grant permission. `mcp_list_resources` returns resources and templates; `mcp_read_resource` accepts a discovered URI template and arguments; `mcp_read_artifact` reads saved bytes in bounded chunks. MCP JSON Schema retains local references, combinations, and additional-property rules without argument coercion. Provider rejection of a schema fails the request instead of silently removing keywords.

Explicit inputs are `{ kind: "mcp_prompt", serverId, name, arguments, task }` and `{ kind: "mcp_resource", serverId, uri, task }`, accepted by runTurn/steer/followUp. Preparation saves one user envelope with `inputContext`; request projection expands original roles followed by the literal task. External assistant context is not evidence of live execution. Restore never fetches the Prompt again. Failed preparation leaves input unprocessed and makes no model request. Budgeting and compaction use the expanded view while history retains the source envelope.

Limits are 16 MiB per result, 8 MiB per attachment, and 64 KiB of model text. Truncation is explicit and links to saved bytes. Images require model image support; audio bytes are retained without claiming transcription; resource links are not fetched automatically. Missing attachments fail with `artifact-missing`, never a new remote request. The default `MemoryMcpArtifactStore` lasts for the instance; persistent-history hosts should inject persistent storage. If a custom store omits optional `delete`, the host owns cleanup of artifacts created by failed input preparation.

The default `MemoryMcpCredentialStore` is instance-local; sharing requires explicit host injection. `McpCredentialStore.withLock` must cover the entire read/refresh/write or logout transaction. Native operations that ignore cancellation retain the lock until actual settlement; a Promise.race must not release it early. `credential-outcome-unknown` does not prove rollback. Logout deletes the local grant and does not guarantee remote revocation. CLI uses a system credential store and a process-shared file lock. Linux defaults to Secret Service; explicit `linux-keyutils` may require login again after a system restart.

Only explicit `login` starts browser authorization. Inject `McpInteraction.beginAuthorization` returning `{ redirectUri, authorize(url), close() }`; authorize returns callback URLSearchParams. Core verifies state, the official SDK handles issuer/code/PKCE, and authentication succeeds only after credentials are saved and a connection is usable. Continue alone is not success. Missing grants or insufficient scope return auth-required; explicit login performs authorization. Adapters should honor signal and close their callback listeners; Core calls close after the adapter returns.

`agent.requests` exposes `mcp_elicitation` with form/url mode, source, and operationId. Respond with `{ decision: "accept", content }`, `{ decision: "decline" }`, or `{ decision: "cancel" }`. Values remain typed numbers, booleans, or arrays; the official SDK validates the form. Late or duplicate responses cannot revive a request.

CLI/TUI commands include status, tools/resources/templates/prompts, enable/disable/refresh/reconnect, login/logout, read, subscribe/unsubscribe, prompt/use-prompt/use-resource, and artifact. `--args '<JSON>'` accepts string-valued objects; the task after `--` is preserved literally. `artifact <id> --output <path>` exclusively creates the destination and refuses overwrite; without output it returns base64. TUI form Tab changes fields, Esc cancels, and Ctrl+P parks the card and retains field drafts. The composer remains editable during management operations. Standalone `--mcp` management needs no model configuration; an interactive terminal asks permission for reads. `--json` never waits for interaction: OAuth exits 24, Elicitation 25, invalid arguments 2, and other failures 1. See [acceptance evidence](phases/mcp-client-acceptance.md) for tested contracts and outstanding real-service/platform validation.
