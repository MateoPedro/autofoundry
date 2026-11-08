import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { foundryTools } from "../src/lib/server/foundry";
import { defineTool, type ToolContext } from "../src/lib/server/foundry/tool";
import { handleRpc } from "../src/lib/server/mcp/protocol";
import { seedCluster, testContext } from "./helpers/fixtures";

async function callTool(ctx: ToolContext, name: string, args: unknown, tools = foundryTools) {
  const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tools, ctx)) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return { isError: res.result.isError ?? false, body: JSON.parse(res.result.content[0].text), chars: res.result.content[0].text.length };
}

test("an unknown id that hits a foreign key returns not_found", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db);
  const offer = {
    cluster_id: clusterId,
    buyer: "b",
    sample: "s",
    product: "p",
    price_cents: 9900,
    channel: "email",
    outreach_message: "Hi {{sample_url}}",
    delivery: "d",
  };
  for (const [name, args] of [
    ["log_decision", { agent: "vc", kind: "hold", company_id: "co_missing", reason: "x" }],
    ["log_decision", { agent: "creator", kind: "hold", cluster_id: "cl_missing", reason: "x" }],
    ["propose_offer", { ...offer, parent_offer_id: "of_missing" }],
  ] as const) {
    const out = await callTool(ctx, name, args);
    assert.equal(out.isError, true, name);
    assert.equal(out.body.error.code, "not_found", `${name}: ${out.body.error.message}`);
    assert.doesNotMatch(out.body.error.message, /foreign key|constraint/);
  }
});

test("an unexpected error returns a fixed message, not the driver's", async () => {
  const ctx = await testContext();
  const leaky = defineTool({
    name: "leaky",
    description: "Throws a driver-style error.",
    writes: false,
    input: z.object({}),
    run: async () => {
      throw new Error("connect ECONNREFUSED db.internal:5432 user=postgres");
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    const out = await callTool(ctx, "leaky", {}, [leaky]);
    assert.equal(out.body.error.code, "internal");
    assert.doesNotMatch(out.body.error.message, /ECONNREFUSED|db\.internal|postgres/);
  } finally {
    console.error = original;
  }
});

test("a tool result over the size limit becomes an error that says to ask for less", async () => {
  const ctx = await testContext();
  const huge = defineTool({ name: "huge", description: "Too big.", writes: false, input: z.object({}), run: async () => ({ text: "x".repeat(9000) }) });
  const out = await callTool(ctx, "huge", {}, [huge]);
  assert.equal(out.isError, true);
  assert.equal(out.body.error.code, "invalid");
  assert.match(out.body.error.message, /limit/);
});
