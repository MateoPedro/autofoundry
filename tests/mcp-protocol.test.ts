import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { foundryTools } from "../src/lib/server/foundry";
import { defineTool, ToolError, type ToolContext } from "../src/lib/server/foundry/tool";
import { setRunning } from "../src/lib/server/foundry/state";
import { handleRpc, isAuthorized } from "../src/lib/server/mcp/protocol";
import { testContext } from "./helpers/fixtures";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  writes: false,
  input: z.object({ text: z.string() }),
  run: async (_ctx, input) => ({ echoed: input.text }),
});

const boom = defineTool({
  name: "boom",
  description: "Always fails.",
  writes: false,
  input: z.object({}),
  run: async () => {
    throw new ToolError("not_found", "no such lead");
  },
});

const paged = defineTool({
  name: "paged",
  description: "Has a defaulted limit.",
  writes: false,
  input: z.object({ query: z.string(), limit: z.number().int().default(10) }),
  run: async (_ctx, input) => input,
});

const tools = [echo, boom, paged];
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
  assert.deepEqual(listed.map((t) => t.name), ["echo", "boom", "paged"]);
  const schema = listed[0].inputSchema as { type: string; properties: { text: { type: string } }; required: string[] };
  assert.equal(schema.type, "object");
  assert.equal(schema.properties.text.type, "string");
  assert.deepEqual(schema.required, ["text"]);
  assert.equal("$schema" in schema, false);
});

// Naïve validates calls against inputSchema, so a defaulted field listed as required fails the call.
test("tools/list leaves a field with a default out of required, and keeps the default", async () => {
  const res = await call("tools/list");
  const listed = res?.result?.tools as { name: string; inputSchema: { required: string[]; properties: Record<string, { default?: unknown }> } }[];
  const schema = listed.find((t) => t.name === "paged")!.inputSchema;
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.properties.limit.default, 10);
});

test("no foundry tool lists a field as required that it accepts missing", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, foundryTools, ctx);
  const listed = (res as Rpc).result?.tools as { name: string; inputSchema: { required?: string[] } }[];
  for (const tool of foundryTools) {
    const required = listed.find((t) => t.name === tool.name)!.inputSchema.required ?? [];
    for (const field of required) {
      assert.equal(tool.input.shape[field].safeParse(undefined).success, false, `${tool.name}.${field} is required but has a default`);
    }
  }
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

async function callReal(real: ToolContext, name: string, args: unknown) {
  const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, foundryTools, real)) as Rpc;
  return { isError: res.result?.isError, body: toolText(res) };
}

test("a writing tool answers stopped while the company is stopped", async () => {
  const real = await testContext();
  await setRunning(real.db, false, real.now());
  const out = await callReal(real, "log_decision", { agent: "vc", kind: "hold", reason: "x" });
  assert.equal(out.isError, true);
  assert.equal(out.body.error.code, "stopped");
  assert.deepEqual(await real.db.query("select id from decisions"), []);
});

test("reading tools still work while stopped", async () => {
  const real = await testContext();
  await setRunning(real.db, false, real.now());
  const out = await callReal(real, "get_metrics", {});
  assert.notEqual(out.isError, true);
});

test("every tool says whether it writes", () => {
  const writing = [
    "add_leads", "monid_read", "screen_batch", "submit_screen", "review", "propose_offer", "spawn", "fund", "kill", "log_decision",
    "log_touch", "publish_sample", "checkout_link", "dismiss_inbound", "reconcile", "write_feedback", "compact_feedback",
  ];
  assert.deepEqual(foundryTools.filter((t) => t.writes).map((t) => t.name).sort(), writing.sort());
});
