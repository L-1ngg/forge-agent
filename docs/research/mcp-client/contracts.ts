import assert from "node:assert/strict";
import {
  Client,
  InMemoryTransport,
  UriTemplate,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Server } from "@modelcontextprotocol/server";
const server = new Server(
  { name: "contracts", version: "1" },
  { capabilities: { tools: { listChanged: true } } },
);
let pages = 0;
let invalidOutput = false;
server.setRequestHandler("tools/list", async (req) => {
  pages++;
  const second = req.params?.cursor === "second";
  return {
    tools: [
      {
        name: second ? "second" : "first",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ],
    ...(second ? {} : { nextCursor: "second" }),
  };
});
server.setRequestHandler("tools/call", async () => ({
  content: [],
  structuredContent: { value: invalidOutput ? 42 : "valid" },
}));
let onChangedResolve: (value: unknown) => void = () => {};
const changed = new Promise((resolve) => (onChangedResolve = resolve));
const client = new Client(
  { name: "contracts-client", version: "1" },
  {
    listChanged: {
      tools: {
        onChanged: (error, tools) =>
          onChangedResolve({ error: error?.message, tools: tools?.length }),
      },
    },
  },
);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);
const startPages = pages;
const list = await client.listTools();
assert.equal(list.tools.length, 2);
assert.equal(list.nextCursor, undefined);
const aggregatePages = pages - startPages;
assert.equal(aggregatePages, 2);
const page = await client.listTools({ cursor: "second" });
assert.equal(page.tools.length, 1);
await client.callTool({ name: "first", arguments: {} });
invalidOutput = true;
let rejected = false;
let outputError = "";
try {
  await client.callTool({ name: "first", arguments: {} });
} catch (e) {
  rejected = true;
  outputError = String(e);
}
assert.equal(rejected, true);
await server.sendToolListChanged();
const notification = await Promise.race([
  changed,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("listChanged timeout")), 2000),
  ),
]);
assert.equal((notification as any).tools, 2);
await client.close();
await server.close();
const validator = new AjvJsonSchemaValidator();
const schemaResults = [];
for (const dialect of [
  undefined,
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
]) {
  const check = validator.getValidator({
    ...(dialect ? { $schema: dialect } : {}),
    type: "object",
    properties: { value: { $ref: "#/$defs/choice" } },
    required: ["value"],
    $defs: { choice: { oneOf: [{ type: "string" }, { type: "number" }] } },
  });
  assert.equal(check({ value: "yes" }).valid, true);
  assert.equal(check({ value: 12 }).valid, true);
  assert.equal(check({ value: false }).valid, false);
  schemaResults.push({
    dialect: dialect ?? "unspecified",
    positive: true,
    negative: true,
  });
}
const template = new UriTemplate("probe://items/{id}{?lang}");
assert.equal(
  template.expand({ id: "a b", lang: "zh" }),
  "probe://items/a%20b?lang=zh",
);
console.log(
  JSON.stringify(
    {
      aggregatePages,
      explicitCursorCount: page.tools.length,
      invalidOutputRejected: rejected,
      outputError,
      listChanged: notification,
      schemaResults,
      uriTemplate: true,
    },
    null,
    2,
  ),
);
