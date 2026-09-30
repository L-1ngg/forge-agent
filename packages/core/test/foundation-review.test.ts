import { expect, test } from "bun:test";
import type { SessionEvent, SessionMessage } from "@forge-agent/protocol";
import { createAgent, MemorySessionStorage, type AgentTurn, type CreateAgentOptions } from "../src/sdk.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import { sessionMessages } from "../src/session-storage.ts";
import { nativeAdapter, responseChunks } from "../../../tests/fixtures/native-adapter.ts";
import { normalizeStreamChunk } from "@tanstack/ai";

const model = getCatalogModel("openai", "gpt-5.4")!;
const parameters = { type: "object" as const, properties: {}, required: [], additionalProperties: false };
const calls: SessionMessage = { role: "assistant", timestamp: 1, stopReason: "tool_use", content: [{ type: "tool_call", id: "first", name: "work", arguments: {} }] };
const answer: SessionMessage = { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "done" }] };
async function collect(turn: AgentTurn): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of turn) events.push(event);
  return events;
}
async function fixture(options: Partial<CreateAgentOptions>) {
  let requests = 0;
  const agent = await createAgent({
    cwd: process.cwd(), systemPrompt: "review fixture", model,
    context: { enabled: false },
    adapter: nativeAdapter(model, async function* () { yield* responseChunks(++requests === 1 ? calls : answer); }),
    ...options,
  });
  return { agent, requests: () => requests };
}

test("an invalid mutation by afterToolCall becomes a durable tool error and permits continuation", async () => {
  const storage = new MemorySessionStorage();
  const { agent, requests } = await fixture({
    storage,
    permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] },
    tools: [{ name: "work", label: "Work", description: "work", parameters, async execute() { return { content: [], details: {} }; } }],
    toolHooks: { afterToolCall(context) { context.result.details = { cannotPersist: 1n }; return undefined; } },
  });
  try {
    const turn = agent.runTurn("work");
    const events = await collect(turn);
    expect(await turn.result).toEqual({ status: "success" });
    expect(requests()).toBe(2);
    expect(events.filter(event => event.type === "tool_execution_end")).toMatchObject([{ isError: true }]);
    expect(sessionMessages(await storage.load()).find(message => message.role === "toolResult")).toMatchObject({ toolCallId: "first", isError: true });
  } finally { await agent.dispose(); }
});

test("mutating a hook's tool-call identity cannot authorize a different executable", async () => {
  let effects = 0;
  const { agent } = await fixture({
    permission: { hooks: [{ evaluate(call) { return call.name === "safe" ? { kind: "allow", source: "hook" } : { kind: "deny", source: "hook", reason: "work is forbidden" }; } }] },
    tools: [{ name: "work", label: "Work", description: "work", parameters, async execute() { effects++; return { content: [], details: {} }; } }],
    toolHooks: { beforeToolCall(context) { context.toolCall.name = "safe"; return undefined; } },
  });
  try {
    await collect(agent.runTurn("work"));
    expect(effects).toBe(0);
  } finally { await agent.dispose(); }
});

test("a retained permission payload cannot change arguments after authorization", async () => {
  const executed: object[] = [];
  const { agent } = await fixture({
    permission: { hooks: [{ evaluate(call) {
      queueMicrotask(() => { Reflect.set(call.arguments, "unvalidated", true); });
      return { kind: "allow", source: "hook" };
    } }] },
    tools: [{ name: "work", label: "Work", description: "work", parameters, async execute(args) { executed.push(structuredClone(args)); return { content: [], details: {} }; } }],
  });
  try {
    await collect(agent.runTurn("work"));
    expect(executed).toEqual([{}]);
  } finally { await agent.dispose(); }
});

test("a spec-normalized length terminal cannot trigger another model request", async () => {
  let requests = 0, effects = 0;
  const { agent } = await fixture({
    adapter: nativeAdapter(model, async function* () {
      const response = ++requests === 1 ? { ...calls, stopReason: "length" as const } : answer;
      for (const raw of responseChunks(response)) yield* normalizeStreamChunk(raw);
    }),
    permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] },
    tools: [{ name: "work", label: "Work", description: "work", parameters, async execute() { effects++; return { content: [], details: {} }; } }],
  });
  try {
    const turn = agent.runTurn("work");
    await collect(turn);
    expect(await turn.result).toEqual({ status: "length" });
    expect(requests).toBe(1);
    expect(effects).toBe(0);
  } finally { await agent.dispose(); }
});

test("a spec-normalized stop terminal with complete calls executes the same tools as raw events", async () => {
  let requests = 0, effects = 0;
  const { agent } = await fixture({
    adapter: nativeAdapter(model, async function* () {
      const response = ++requests === 1 ? { ...calls, stopReason: "stop" as const } : answer;
      for (const raw of responseChunks(response)) yield* normalizeStreamChunk(raw);
    }),
    permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] },
    tools: [{ name: "work", label: "Work", description: "work", parameters, async execute() { effects++; return { content: [], details: {} }; } }],
  });
  try {
    const turn = agent.runTurn("work");
    await collect(turn);
    expect(await turn.result).toEqual({ status: "success" });
    expect(effects).toBe(1);
    expect(requests).toBe(2);
  } finally { await agent.dispose(); }
});
