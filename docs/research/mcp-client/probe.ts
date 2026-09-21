import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { factory } from "./fixture";
const result: unknown[] = [];
for (const transportKind of ["stdio", "http"] as const)
  for (const mode of ["legacy", "auto", { pin: "2026-07-28" }] as const) {
    const handler =
      transportKind === "http" ? createMcpHandler(factory) : undefined;
    const listener = handler
      ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler.fetch })
      : undefined;
    const transport =
      transportKind === "stdio"
        ? new StdioClientTransport({
            command: process.execPath,
            args: [`${import.meta.dir}/fixture.ts`],
            stderr: "pipe",
          })
        : new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${listener!.port}/mcp`),
          );
    const client = new Client(
      { name: "forge-probe-client", version: "1" },
      { versionNegotiation: { mode } },
    );
    try {
      await client.connect(transport, { timeout: 3000 });
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 2);
      const echo = await client.callTool({
        name: "echo",
        arguments: { value: "verified" },
      });
      assert.deepEqual(echo.structuredContent, { value: "verified" });
      assert.equal((await client.listResources()).resources.length, 1);
      assert.equal(
        (await client.readResource({ uri: "probe://readme" })).contents[0].text,
        "resource text",
      );
      assert.equal(
        (await client.listResourceTemplates()).resourceTemplates.length,
        1,
      );
      assert.equal(
        (await client.readResource({ uri: "probe://items/one" })).contents[0]
          .text,
        "one",
      );
      assert.deepEqual(
        (
          await client.complete({
            ref: { type: "ref/resource", uri: "probe://items/{id}" },
            argument: { name: "id", value: "" },
          })
        ).completion.values,
        ["one", "two"],
      );
      assert.equal((await client.listPrompts()).prompts.length, 1);
      assert.equal(
        (
          await client.getPrompt({
            name: "greet",
            arguments: { name: "Forge" },
          })
        ).messages[0].content.text,
        "Hello Forge",
      );
      const abort = new AbortController();
      const t = setTimeout(() => abort.abort(new Error("probe cancelled")), 50);
      const start = performance.now();
      let cancelled = false;
      try {
        await client.callTool(
          { name: "slow", arguments: {} },
          { signal: abort.signal, timeout: 1000 },
        );
      } catch (e) {
        cancelled = true;
      } finally {
        clearTimeout(t);
      }
      assert.equal(cancelled, true);
      assert.equal(abort.signal.aborted, true, "a protocol error before abort is not cancellation evidence");
      const cancelMs = Math.round(performance.now() - start);
      assert.ok(cancelMs < 1000);
      const pid =
        transport instanceof StdioClientTransport ? transport.pid : undefined;
      await client.close();
      let childExited = true;
      if (pid) {
        try {
          process.kill(pid, 0);
          childExited = false;
        } catch {}
      }
      assert.equal(childExited, true);
      result.push({
        transport: transportKind,
        mode,
        tools: tools.tools.length,
        resource: true,
        resourceTemplate: true,
        completion: true,
        prompt: true,
        structuredOutput: true,
        cancelMs,
        childExited: pid ? childExited : null,
      });
    } finally {
      await client.close();
      await handler?.close();
      await listener?.stop(true);
    }
  }
console.log(JSON.stringify({ bun: Bun.version, results: result }, null, 2));
