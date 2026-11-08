import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineTool, ToolError, type ToolContext } from "../src/lib/server/foundry/tool";
import { handleRpc, isAuthorized } from "../src/lib/server/mcp/protocol";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  input: z.object({ text: z.string() }),
  run: async (_ctx, input) => ({ echoed: input.text }),
});

const boom = defineTool({
  name: "boom",
  description: "Always fails.",
  input: z.object({}),
  run: async () => {
    throw new ToolError("not_found", "no such lead");
  },
});

const tools = [echo, boom];
const ctx = { db: null, spend: null, now: () => new Date("2026-11-08T08:00:00Z") } as unknown as ToolContext;

type Rpc = { result?: Record<string, unknown>; error?: { code: number } };

async function call(method: string, params: unknown = {}, id: number | undefined = 1) {
  return (await handleRpc({ jsonrpc: "2.0", id, method, params }, tools, ctx)) as Rpc | null;
}

function toolText(res: Rpc | null) {
  const content = res?.result?.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

test("initialize answers the client's protocol version when supported", async () => {
  const res = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  assert.equal(res?.result?.protocolVersion, "2025-03-26");
  assert.deepEqual(res?.result?.capabilities, { tools: {} });
  assert.equal((res?.result?.serverInfo as { name: string }).name, "foundry");
});

test("initialize falls back to 2025-06-18 for an unknown version", async () => {
  const res = await call("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  assert.equal(res?.result?.protocolVersion, "2025-06-18");
});

test("notifications/initialized returns null", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, tools, ctx);
  assert.equal(res, null);
});

test("tools/list returns name, description and a JSON Schema inputSchema", async () => {
  const res = await call("tools/list");
  const listed = res?.result?.tools as { name: string; description: string; inputSchema: Record<string, unknown> }[];
  assert.deepEqual(listed.map((t) => t.name), ["echo", "boom"]);
  const schema = listed[0].inputSchema as { type: string; properties: { text: { type: string } }; required: string[] };
  assert.equal(schema.type, "object");
  assert.equal(schema.properties.text.type, "string");
  assert.deepEqual(schema.required, ["text"]);
  assert.equal("$schema" in schema, false);
});

test("tools/call returns the result as JSON text content", async () => {
  const res = await call("tools/call", { name: "echo", arguments: { text: "hi" } });
  assert.deepEqual(toolText(res), { echoed: "hi" });
  assert.equal(res?.result?.isError, undefined);
});

test("tools/call with invalid arguments returns isError with code invalid", async () => {
  const res = await call("tools/call", { name: "echo", arguments: { text: 5 } });
  assert.equal(res?.result?.isError, true);
  assert.equal(toolText(res).error.code, "invalid");
});

test("a ToolError becomes isError with its code and message", async () => {
  const res = await call("tools/call", { name: "boom", arguments: {} });
  assert.equal(res?.result?.isError, true);
  assert.deepEqual(toolText(res), { error: { code: "not_found", message: "no such lead" } });
});

test("an unknown tool returns isError, not a JSON-RPC error", async () => {
  const res = await call("tools/call", { name: "nope", arguments: {} });
  assert.equal(res?.error, undefined);
  assert.equal(res?.result?.isError, true);
  assert.equal(toolText(res).error.code, "not_found");
});

test("an unknown method returns JSON-RPC error -32601", async () => {
  const res = await call("resources/list");
  assert.equal(res?.error?.code, -32601);
});

test("isAuthorized rejects a missing, wrong or empty bearer and an unset token", () => {
  assert.equal(isAuthorized(null, "t"), false);
  assert.equal(isAuthorized("Bearer x", "t"), false);
  assert.equal(isAuthorized("Bearer ", ""), false);
  assert.equal(isAuthorized("Bearer t", undefined), false);
  assert.equal(isAuthorized("t", "t"), false);
  assert.equal(isAuthorized("Bearer t", "t"), true);
});
