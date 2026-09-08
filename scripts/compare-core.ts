/** Compare a pristine fixed checkout with the locally owned runtime. No provider calls. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import ts from "typescript";
import { EventStream, type AssistantMessageEvent, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { Agent } from "../packages/core/src/runtime/agent.ts";
import type { AgentEvent, AgentTool, QueueMode } from "../packages/core/src/runtime/types.ts";

const revision = "9767ba275f3e9a5ee0f5c5342249b629ab1b2282";
const upstream = process.argv[2];
if (!upstream) throw new Error("Usage: bun scripts/compare-core.ts /path/to/pristine/pi-checkout");
const head = Bun.spawnSync(["git", "-C", upstream, "rev-parse", "HEAD"]);
assert.equal(head.stdout.toString().trim(), revision, "Oracle must be the fixed upstream revision");
for (const name of ["agent.ts", "agent-loop.ts", "types.ts", "stream-fn.ts"]) {
 const original: Bun.SyncSubprocess = Bun.spawnSync(["git", "-C", upstream, "show", `${revision}:packages/agent/src/${name}`]);
 assert.equal(original.exitCode, 0);
 const actual: string = readFileSync(resolve(upstream, "packages/agent/src", name), "utf8");
 assert.equal(actual, original.stdout!.toString(), `Oracle source changed: ${name}`);
 // Type-only build adaptations must not change executable JavaScript.
 const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
 if (!process.argv.includes("--behavior-only")) assert.equal(compile(readFileSync(resolve("packages/core/src/runtime", name), "utf8")), compile(actual), `Baseline has executable differences: ${name}`);
}
// Isolate the four verified sources from upstream workspace resolution: both sides use
// the exact same installed model transport, so the comparison isolates the core.
const oracleDir = mkdtempSync(resolve(tmpdir(), "forge-core-oracle-"));
for (const name of ["agent.ts", "agent-loop.ts", "types.ts", "stream-fn.ts"]) writeFileSync(resolve(oracleDir, name), readFileSync(resolve(upstream, "packages/agent/src", name)));
symlinkSync(resolve("node_modules"), resolve(oracleDir, "node_modules"), "dir");
process.on("exit", () => rmSync(oracleDir, { recursive: true, force: true }));
const Oracle: typeof Agent = (await import(pathToFileURL(resolve(oracleDir, "agent.ts")).href)).Agent;
const model = { id: "script", name: "script", api: "openai-responses", provider: "openai", baseUrl: "", reasoning: true, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
function message(stopReason: AssistantMessage["stopReason"], tools: boolean): AssistantMessage {
 return { role: "assistant", api: "openai-responses", provider: "openai", model: "script", timestamp: 0, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: tools ? ["a", "b"].map(id => ({ type: "toolCall", id, name: "work", arguments: { id } })) : [{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }] };
}
function normalized(value: unknown): unknown {
 return JSON.parse(JSON.stringify(value, (key, item) => key === "timestamp" ? 0 : item));
}
async function trace(Runtime: typeof Agent, reason: AssistantMessage["stopReason"], mode: QueueMode, sequential: boolean, continuation = false) {
 const trace: unknown[] = [];
 let requests = 0;
 const tool: AgentTool = { name: "work", label: "Work", description: "fixture", parameters: Type.Object({ id: Type.String() }), ...(sequential ? { executionMode: "sequential" as const } : {}), prepareArguments(args) { trace.push(["prepare", structuredClone(args)]); return args as { id: string }; }, async execute(id, args, signal, update) { trace.push(["execute", id, args]); update?.({ content: [{ type: "text", text: "progress" }], details: { id } }); if (id === "a") await new Promise(resolve => setTimeout(resolve, 5)); return { content: [{ type: "text", text: id }], details: { id } }; } };
 const agent = new Runtime({ initialState: { model, tools: [tool] }, steeringMode: mode, followUpMode: mode, beforeToolCall: async ({ args }) => { trace.push(["before", structuredClone(args)]); return undefined; }, afterToolCall: async ({ args }) => { trace.push(["after", structuredClone(args)]); return undefined; }, streamFn: (_model, context) => {
  trace.push(["request", normalized(context)]);
  const reply = message(requests++ === 0 ? reason : "stop", requests === 1 && reason !== "stop");
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(event => event.type === "done" || event.type === "error", event => { if (event.type === "done") return event.message; if (event.type === "error") return event.error; throw new Error("Unexpected non-terminal result"); });
  stream.push({ type: "start", partial: structuredClone(reply) });
  for (const [index, block] of reply.content.entries()) {
   if (block.type === "text") stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: structuredClone(reply) });
   if (block.type === "thinking") stream.push({ type: "thinking_delta", contentIndex: index, delta: block.thinking, partial: structuredClone(reply) });
   if (block.type === "toolCall") stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: structuredClone(reply) });
  }
  if (reply.stopReason === "error" || reply.stopReason === "aborted") stream.push({ type: "error", reason: reply.stopReason, error: reply });
  else stream.push({ type: "done", reason: reply.stopReason as "stop" | "length" | "toolUse", message: reply });
  stream.end(reply); return stream;
 } });
 agent.subscribe(async (event: AgentEvent) => { trace.push(structuredClone(event)); if (event.type === "agent_end") { trace.push(["end-busy", agent.state.isStreaming]); await Promise.resolve(); } });
 for (const text of ["steer1", "steer2"]) agent.steer({ role: "user", content: text, timestamp: 0 });
 for (const text of ["follow1", "follow2"]) agent.followUp({ role: "user", content: text, timestamp: 0 });
 if (continuation) { agent.state.messages = [{ role: "user", content: "hello", timestamp: 0 }]; await agent.continue(); }
 else await agent.prompt("hello");
 assert.ok(requests > 0, "Fixture must invoke the model stream");
 if (reason === "toolUse" || reason === "deferred") assert.equal(trace.filter(item => Array.isArray(item) && item[0] === "execute").length, 2, "Fixture must execute both tools");
 await agent.waitForIdle(); trace.push(["idle", agent.state.isStreaming, agent.state.messages]);
 return normalized(trace);
}
let compared = 0;
for (const reason of ["stop", "toolUse", "error", "aborted", "length", "deferred"] as const) {
 for (const mode of ["all", "one-at-a-time"] as const) {
  for (const sequential of [false, true]) {
   assert.deepEqual(await trace(Agent, reason, mode, sequential), await trace(Oracle, reason, mode, sequential), `${reason}/${mode}/${sequential}`); compared++;
  }
 }
}
assert.deepEqual(await trace(Agent, "toolUse", "all", false, true), await trace(Oracle, "toolUse", "all", false, true));
console.log(`${compared + 1} differential scripts passed; only timestamps normalized${process.argv.includes("--behavior-only") ? "" : "; executable baseline identical"}.`);
