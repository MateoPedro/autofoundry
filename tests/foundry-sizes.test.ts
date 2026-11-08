import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { foundryTools } from "../src/lib/server/foundry";
import { listClusters } from "../src/lib/server/foundry/leads";
import type { ToolContext } from "../src/lib/server/foundry/tool";
import { newId } from "../src/lib/server/ids";
import { handleRpc } from "../src/lib/server/mcp/protocol";
import { seedCluster, seedCompany, testContext } from "./helpers/fixtures";

// Naïve cuts any tool result longer than 8,000 characters before an agent reads it.
const LIMIT = 8000;
const text = (n: number) => "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil(n / 57)).slice(0, n);
const leadData = () => ({
  rating: 4.2,
  reviews: 128,
  issues: ["no mobile layout", "menu is a scanned PDF", "contact form returns a 404 page"],
  screenshot_file_id: newId("cl").replace("cl_", "fil_"),
  notes: text(120),
});

async function callTool(ctx: ToolContext, name: string, args: unknown) {
  const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, foundryTools, ctx)) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  const raw = res.result.content[0].text;
  assert.equal(res.result.isError, undefined, raw.slice(0, 300));
  return { chars: raw.length, body: JSON.parse(raw) };
}

async function insertLead(ctx: ToolContext, clusterId: string, companyId: string | null, i: number) {
  const id = newId("ld");
  await ctx.db.query(
    `insert into leads (id, cluster_id, company_id, name, url, contact_url, email, external_id, status, sample_url, data)
     values ($1, $2, $3, $4, $5, $6, $7, $1, 'contacted', $8, $9)`,
    [
      id,
      clusterId,
      companyId,
      `Mission Street Family Dental Group ${i}`,
      `https://missionstreetfamilydental${i}.example.com`,
      `https://missionstreetfamilydental${i}.example.com/contact-us`,
      `frontdesk${i}@missionstreetfamilydental.example.com`,
      `https://co-01-p2jr2103s9ve.vercel.app/${id}`,
      leadData(),
    ],
  );
  return id;
}

test("list_pending stays under the limit at its defaults and still shows offers", async () => {
  const ctx = await testContext();
  for (let c = 0; c < 12; c++) {
    const clusterId = await seedCluster(ctx.db, `Independent dental practices in San Francisco with outdated sites ${c}`, "pending");
    for (let i = 0; i < 3; i++) await insertLead(ctx, clusterId, null, i);
  }
  const approved = await seedCluster(ctx.db, "approved cluster", "approved");
  for (let o = 0; o < 4; o++) {
    await ctx.db.query(
      `insert into offers (id, cluster_id, buyer, sample, product, price_cents, channel, outreach_message, follow_up_message, delivery)
       values ($1, $2, $3, $4, $5, 9900, 'contact_form', $6, $7, $8)`,
      [newId("of"), approved, text(120), text(150), text(200), `${text(700)} {{sample_url}}`, text(300), text(150)],
    );
  }
  const { chars, body } = await callTool(ctx, "list_pending", {});
  assert.ok(chars < LIMIT, `list_pending is ${chars} characters`);
  assert.ok(body.offers.length >= 1, "offers are not crowded out by clusters");
});

test("get_metrics stays under the limit at its defaults with a long history", async () => {
  const ctx = await testContext();
  const ids: string[] = [];
  for (let c = 0; c < 12; c++) {
    const { companyId } = await seedCompany(ctx.db, { status: c < 8 ? "killed" : "active", slug: `co-${String(c).padStart(2, "0")}` });
    ids.push(companyId);
  }
  for (let d = 0; d < 20; d++) {
    await ctx.db.query("insert into decisions (id, agent, kind, company_id, reason) values ($1, 'funder', 'kill', $2, $3)", [
      newId("dc"),
      ids[d % ids.length],
      text(150),
    ]);
  }
  const { chars, body } = await callTool(ctx, "get_metrics", {});
  assert.ok(chars < LIMIT, `get_metrics is ${chars} characters`);
  assert.ok(body.companies.some((c: { status: string }) => c.status === "active"), "live companies are always listed");
});

test("get_company stays under the limit at its defaults with a busy company", async () => {
  const ctx = await testContext();
  const { clusterId, companyId } = await seedCompany(ctx.db);
  for (let i = 0; i < 20; i++) {
    const leadId = await insertLead(ctx, clusterId, companyId, i);
    for (let t = 0; t < 5; t++) {
      await ctx.db.query(
        "insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail) values ($1, $2, $3, 'co-01-outreach', 'contact_form', 'sent', $4)",
        [newId("tc"), companyId, leadId, text(150)],
      );
    }
  }
  for (const agent of ["agt_builder", "agt_outreach", "agt_closer"]) {
    for (let s = 0; s < 30; s++) {
      await ctx.db.query("insert into spend (company_id, agent_id, agent_name, micro_usd, synced_at) values ($1, $2, $2, $3, $4)", [
        companyId,
        agent,
        s * 1000,
        new Date(Date.UTC(2026, 10, 8, 0, s * 5)),
      ]);
    }
  }
  const { chars } = await callTool(ctx, "get_company", { company_id: companyId });
  assert.ok(chars < LIMIT, `get_company is ${chars} characters`);
});

test("list_clusters stays under the limit at its largest limit", async () => {
  const ctx = await testContext();
  for (let c = 0; c < 40; c++) await seedCluster(ctx.db, `Independent dental practices in San Francisco with outdated sites ${c}`, "approved");
  const max = (z.toJSONSchema(listClusters.input) as unknown as { properties: { limit: { maximum: number } } }).properties.limit.maximum;
  const { chars } = await callTool(ctx, "list_clusters", { limit: max });
  assert.ok(chars < LIMIT, `list_clusters at limit ${max} is ${chars} characters`);
});

test("list_offers stays under the limit at its defaults with long offers", async () => {
  const ctx = await testContext();
  const clusterId = await seedCluster(ctx.db, "approved cluster", "approved");
  for (let o = 0; o < 12; o++) {
    await ctx.db.query(
      `insert into offers (id, cluster_id, buyer, sample, product, price_cents, channel, outreach_message, follow_up_message, delivery, review_status, review_reason)
       values ($1, $2, $3, $4, $5, 9900, 'contact_form', $6, $7, $8, 'rejected', $9)`,
      [newId("of"), clusterId, text(300), text(500), text(500), `${text(1900)} {{sample_url}}`, text(2000), text(500), text(500)],
    );
  }
  const { chars, body } = await callTool(ctx, "list_offers", {});
  assert.ok(chars < LIMIT, `list_offers is ${chars} characters`);
  assert.equal(body.offers.length, 5);
});
