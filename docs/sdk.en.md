# Embedding Forge Agent

[简体中文](sdk.md) · [Project README](../README.md)

The SDK is a private Bun workspace package, exported at `@forge-agent/core/sdk`. It is not published on npm and does not promise Node.js compatibility or process isolation.

## Custom Execution Implementations

Normally, use the default `createAgent(options)`. A factory supplied as the second argument must return a complete `AgentPort` (import its type from `@forge-agent/core`), or a Promise of one. Required methods are `runTurn`, `continue`, `steer`, `followUp`, `abort`, `dispose`, `getUsage`, `setStorage`, `compact`, `configureContext`, and `updateConfiguration`.

TypeScript checks the complete type. Creation also checks that every method is callable, rejecting missing or non-callable methods with a `TypeError`. It then awaits `setStorage(storage)` before returning the Agent, including when using default memory storage. `setStorage` is an assembly capability, not part of the returned Agent's host interface. These checks do not run models or tools and cannot prove implementation semantics: `getUsage()` may return `undefined`, and configuration updates may reject unsupported settings.

If capability validation or storage attachment fails after the factory returns, creation attempts `abort()` and then awaits `dispose()`, even if abort throws. It first closes an internally created RequestBus; it does not explicitly close an externally supplied bus on assembly failure (the adapter remains responsible for its own cancellation behavior). Bus ownership on disposal after successful creation is unchanged. Successful cleanup preserves the original creation error. If cleanup also fails, an `AggregateError` retains the original error in `cause` and `errors[0]`, followed by cleanup errors. A factory that throws before returning an instance must clean up resources it has not handed over.

Local UI/headless tests may keep their smaller interfaces. Tests using the full SDK creation path should use production sessions with controlled models. See the [assembly design and verification](phases/agent-assembly.md) (Chinese).

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

Adaptive task requests use short checkpoint notes: state/claim kind, full text, and deduplicated source entryIds. Full quotes, state IDs, and replacement relationships remain in persisted checkpoints and the fallback summary; the execution ledger is retained. Summary generation still extracts full evidence, so this does not imply lower summary-generation cost.

The reserved `search_context` tool finds saved messages within the current branch when an entryId is unknown. Supply `query` (1–200 Unicode code points, at most 8 whitespace-separated literal words, all must match, case-insensitive), optional `role` (`user`, `assistant`, `toolResult`), and `limit` (default 5, maximum 10). Results are newest first by branch order, with `entryId`, `role`, `isError`, Unicode `offset`, a preview of at most 256 code points, and a `hasMore` flag. Use `read_context` for full text. This is literal search, not semantic interpretation of the latest decision. To avoid recursive echoes, search excludes results from either retrieval tool and assistant messages containing their calls; those records remain readable by ID. Search uses the same permissions, hooks and cancellation boundary, adds no model dependency, and never accesses other branches, sessions or files. Its schema and retrieved text add input overhead, so net token savings are workload-dependent.

`context.strategy` defaults to `"pi"`, preserving the existing behavior below. Set `"adaptive"` to opt into sourced task checkpoints, relevant history selection, bounded historical lookup, and request budgeting. This does not imply better quality on every model or workload.

Adaptive compaction protects unarchived user input and the latest complete interaction, first attempting bounded tool-body clipping and local selection. When needed, the task model extracts separate states and summary claims with exact saved-message references. Replacements require later user evidence; assistant statements are conservatively classified as inference. Recorded tool outcomes remain the execution evidence. Checkpoints never authorize tools, and structural validation does not prove semantic completeness.

Each adaptive operation allows at most two logical generations and four actual model requests, including transient retries. The fourth incremental update, a task change, an invalid checkpoint or lack of progress can trigger rebuilding from original records. Oversized summary input, protected context that cannot fit, invalid references, and final lack of progress fail without publishing an invalid checkpoint. Automatic failure prevents that over-budget task request; cancellation and storage failures retain their existing lifecycle contracts.

Without an explicit task `maxTokens`, adaptive sends `min(4096, model.maxTokens)`, unlike pi's provider default. Its budget includes system text, tool definitions, states, summaries and messages, reserving `max(reserveTokens, effectiveOutputTokens + max(1024, ceil(contextWindow * 0.02)))`. Effective output includes additional provider thinking budgets where applicable. Heuristic counts do not guarantee the physical provider window will fit. Summary input is checked separately and its output is capped at 4096 tokens, further limited by model capacity and the declared window.

Adaptive registers the reserved `read_context` tool through existing permission checks and tool hooks. It reads only saved messages in the selected session branch; a conflicting host tool name is rejected. Arguments are `entryId`, `offset` (default 0) and `limit` (default/maximum 4096), measured in Unicode code points. Text is capped at 16 KiB; `nextOffset` supports continuing long single lines. Metadata also counts toward subsequent context. Images return placeholders, and content never saved by the original tool cannot be recovered. Missing, out-of-range, and off-branch references fail explicitly. Hosts wanting automatic retrieval must allow this tool using their existing permission configuration.

Versioned optional `adaptive` payloads extend v4 compaction records. Reopening validates references and state replacement transitions; old histories without these payloads remain readable. With the same new SDK, switching to pi uses a readable fallback summary and legal recent suffix; switching back to adaptive reconstructs the view from original messages. Older SDK versions are not guaranteed to reproduce adaptive projections. Disabling automatic compaction does not remove the lookup tool or disable manual compaction.

Adaptive `compaction` events add `strategy`, `action`, `inputBudget`, `contextEstimated`, `modelCalls`, `generations`, `elapsedMs`, `stopReason`, and aggregate `usage`. These are cumulative snapshots: use the latest event per `operationId`, rather than adding snapshots. The fixed threshold, two-summary structure, and failure continuation rules below apply to pi.

The creation option `context: { enabled, reserveTokens, keepRecentTokens, summaryReasoning }` defaults to `true`, `16384`, `20000`, and `"inherit"`. Update it while idle with `agent.configureContext(partial)`. Every task request checks whether estimated context strictly exceeds `contextWindow - reserveTokens`; recent tokens guide legal cut selection rather than imposing a final context cap.

`contextWindow` optionally overrides the local capacity declaration, defaulting to model metadata. Lowering it tests triggering, not physical provider overflow. `maxTokens` controls ordinary task output independently of compaction reserve; provider defaults apply when omitted. `getUsage().contextEstimated` distinguishes measured usage from estimation. Model, system, tool, branch and projection changes invalidate prior anchors; summary usage never anchors task context.

Historical user/toolResult content may include `{ type: "image", data: base64, mimeType }`. Requests retain the image, estimation counts 1024 tokens per image, and summaries serialize a placeholder. Task and summary pi-ai calls share `sessionId`: generated per instance by default, optionally supplied by the host, and derived from the session header in the CLI. Provider compatibility and cache settings control HTTP affinity fields; `cacheRetention: "none"` may suppress them.

`await agent.compact(instructions?, onEvent?)` aborts active work, waits for tool and persistence cleanup, then compacts once without resuming the task. It returns `{ status, operationId, beforeTokens, afterTokens?, error? }`, with status `complete`, `skipped` or `error`. Storage faults still throw and disable the instance. Abort interrupts summaries and retry waits but waits for started writes. Instructions only focus the history summary.

Summaries use the task model, authentication and routing, with no tools and `cacheRetention: "none"`. At most two logical requests generate history and an optional turn-prefix summary, concatenated directly. Reasoning inherits the task by default; `summaryReasoning: "off"` disables it only when supported, otherwise inheritance and the fallback reason are reported. The top-level `retry` policy defaults to enabled, three retries and a 2000 ms base delay: 2/4/8 seconds. Only classified transient responses retry the failed logical summary; provider retries are disabled and there is no cumulative summary-call cap.

Failed proactive compaction preserves the view and permits the task request. Overflow and eligible length responses share one compaction recovery per continuous failure chain, including failures after partial text. Failed attempts remain in history, completed tools are never replayed, and successful answers are never regenerated just because reported usage exceeds the window. `enabled: false` disables automatic compaction and recovery; manual compaction remains available.

Ordinary output-limit `length` text remains in subsequent requests; truncated tool calls are neither executed nor projected. A `length` attempt classified for context recovery stores `contextExcluded`, retaining its raw record while excluding it after reopening. Headless returns success after successful recovery, 1 for unrecovered error/length, and 130 for cancellation.

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

Breaking out of the loop or closing the iterator cancels and awaits cleanup. `abort()` also handles an acquired iterator that has not started: later consumption cannot launch a model request, tool, or commit. After cleanup, the instance can be reused. Background execution still needs a host continuously consuming the event stream; UI subscribers can observe forwarded events.

`dispose()` is idempotent, refuses new work, and awaits cancellation cleanup or an already-started commit. Always await it, including when holding an unfinished iterator. Custom tools must cooperate with `AbortSignal`; an uncooperative tool can delay cancellation or disposal indefinitely. The SDK cannot forcibly terminate code in its own process.

## Permissions

Tool calls without an allow policy request authorization. Supply `permission.rules`, or consume `agent.requests` concurrently with `runTurn()` and answer through `agent.respond(...)`. Never wait for the execution loop to finish before handling its permission request.

For a permission request, respond with its exact ID and one of these result shapes:

```ts
agent.respond({ type: "response", id: request.id, result: { decision: "allow_once" } });
agent.respond({ type: "response", id: request.id, result: { decision: "deny", reason: "Host policy" } });
```

Choose one result after checking `request.kind === "permission"` and consulting the host's user or policy. Persistent approval uses `allow_always` with a typed scope derived from the exact tool call by `permissionScopeForToolCall` in `@forge-agent/protocol`; only offer it when the request permits remembering a rule. The example's narrow allow rule avoids interactive prompts for its single marker tool; it is not a recommendation to allow arbitrary tools.

Unanswered requests default to denial after 30 seconds. Having no UI does not grant permission. Instances have independent permission memory and request buses by default. The CLI passes an exclusive bus and allows interactive users to wait without a timeout. Disposal closes the instance's bus, including a host-supplied one; do not share that bus across instances.

The host should stop its request-consumer task when disposal closes the stream and propagate consumer failures by aborting execution. Observation, responses, and release do not require pi types.

## Validation Boundaries

Automated tests use local HTTP providers, tool and storage fault injection, generated interleavings, and PTY interaction. They do not establish a stable public API, full real-provider coverage, long-task reliability, or filesystem crash consistency. Current internal acceptance evidence is in the [SDK construction record](phases/sdk.md) (Chinese).

## Source-owned Runtime Interface Update

The package name and `createAgent` remain unchanged. The local runtime derives from a fixed Agent source revision; Forge owns persistence, permissions, context policies and usage. Internal `ExecutionCore`, `AgentRunner` and the old permission adapter factory are removed. Hosts create instances through the SDK.

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

`turn.result` settles after consumption and required persistence. `waitForIdle()` waits for the currently acquired iterator or manual compaction to settle; it does not indicate model success. `agent_end.outcome` reports the final session outcome; an intermediate error during retry is not the final failure. `deferred` is terminal, with no background polling. Consume the lazy stream, or acquire and close its iterator; an unconsumed stream starts no work.

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

`content` contains model-visible text/images. `details` is independently persisted for host display and must support JSON persistence and snapshotting. Return `isError: true` or throw for failures; `terminate: true` hints that execution should stop. Progress uses the same result shape; updates after settlement are ignored. `prepareArguments` synchronously normalizes input; `toolInputRewrites` may rewrite asynchronously. Schema validation, rewriting, before hooks, final validation and authorization finish serially in call order before parallel effects start. `executionMode: "sequential"` selects per-tool execution; `toolHooks.toolExecution` selects a batch policy. `beforeToolCall` returns block/reason/terminate; `afterToolCall` may override content/details/isError/terminate. Authorization, execution and after hooks observe the same final arguments. Failed preparation skips that effect; results persist in model call order.

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

Updates support provider/model/apiKey/baseUrl/systemPrompt/thinkingLevel/tools/maxTokens/contextWindow. Asynchronous validation failure rejects the update and preserves the previous configuration. Idle updates apply immediately. During execution, the current response and its complete tool batch retain their original configuration; the update applies before the next request. Manual summaries finish before updates apply. No extra model request is made solely to apply a configuration. Disposal or storage faults cancel pending updates. Await `applied` outside the event consumption loop. Tool schemas are snapshotted before acceptance; callback closures remain host-owned. Applying an update invalidates the current usage anchor while preserving historical last-call counters.

See the [migration evidence](phases/pi-core-migration-acceptance.md) (Chinese) for provenance, local changes, verification and version rollback.
