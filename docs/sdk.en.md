# Embedding Forge Agent

[简体中文](sdk.md) · [Project README](../README.md)

The SDK is a private Bun workspace package, exported at `@forge-agent/core/sdk`. It is not published on npm and does not promise Node.js compatibility or process isolation.

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

Each instance starts with independent in-memory storage. A host may provide this interface, exported from `@forge-agent/core/sdk`:

```ts
import type { SessionMessage } from "@forge-agent/protocol";

interface SessionStorage {
  load(): Promise<SessionMessage[]>;
  appendTurn(messages: readonly SessionMessage[]): Promise<void>;
}
```

Declare `@forge-agent/protocol` as a workspace dependency when importing its message types. `createAgent` loads history once. Fully consuming a successful invocation commits it once, including tool continuation turns and processed interventions. Errors, cancellation, or iterator closure before commit prevent that invocation from being committed.

Once `appendTurn()` starts, cancellation and disposal wait for it to settle. They cannot revoke an arbitrary host write. Preserve the entire `SessionMessage`, including provider continuation signatures. The CLI's `SessionStore.asStorage()` retains the v3 JSONL format.

The storage adapter owns transactions, retries, and recovery. Do not let multiple instances write the same session concurrently. A failed commit throws to the consumer and faults the instance: inspect the actual storage state before recreating it. An exception does not prove that nothing was written. JSONL append has no transaction guarantee for power loss or partial writes; damaged files may require repair. Tool side effects are never rolled back.

## Events, Input, and Lifecycle

`runTurn(input)` returns a single-consumer async iterable with a readonly `id: symbol`. Each instance runs one invocation at a time; concurrent execution is rejected rather than queued. Multiple instances can run independently.

`steer(input, turn.id)` and `followUp(input, turn.id)` target the active invocation's separate FIFO queues. They return `{ accepted: false }` if execution has not started, has ended, is cancelling, or the ID is stale. A disposed or faulted instance throws. Hosts must retain input until its receipt resolves.

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
