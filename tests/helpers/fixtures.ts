import type { Db } from "../../src/lib/server/db";
import type { Tool, ToolContext } from "../../src/lib/server/foundry/tool";
import { newId } from "../../src/lib/server/ids";
import { createTestDb } from "./test-db";

export const NOW = new Date("2026-11-08T08:00:00Z");

export async function testContext(overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
  const ctx: ToolContext = {
    db: await createTestDb(),
    spend: null,
    naive: null,
    payments: null,
    appUrl: "https://foundry.test",
    now: () => NOW,
    ...overrides,
  };
  await ctx.db.query("update foundry_state set running = true where id = 1");
  return ctx;
}

export function run(tool: Tool, ctx: ToolContext, args: unknown) {
  return tool.run(ctx, tool.input.parse(args));
}

export async function seedCluster(db: Db, label = "SF dentists", reviewStatus = "approved") {
  const id = newId("cl");
  await db.query("insert into clusters (id, label, source, review_status) values ($1, $2, 'google_maps', $3)", [id, label, reviewStatus]);
  return id;
}

export async function seedOffer(db: Db, clusterId: string, reviewStatus = "approved") {
  const id = newId("of");
  await db.query(
    `insert into offers (id, cluster_id, buyer, sample, product, price_cents, channel, outreach_message, delivery, review_status)
     values ($1, $2, 'SF dentists', 'a rebuilt one-page site', 'One-page site on your domain', 9900, 'contact_form',
             'Hi {{lead_name}}, I am an AI agent. {{sample_url}}', 'a link by email', $3)`,
    [id, clusterId, reviewStatus],
  );
  return id;
}

export async function seedCompany(db: Db, opts: { status?: string; clusterId?: string; slug?: string } = {}) {
  const clusterId = opts.clusterId ?? (await seedCluster(db, `cluster ${newId("cl")}`));
  const offerId = await seedOffer(db, clusterId);
  const companyId = newId("co");
  await db.query("insert into companies (id, slug, offer_id, cluster_id, status) values ($1, $2, $3, $4, $5)", [
    companyId,
    opts.slug ?? `co-${companyId.slice(-4)}`,
    offerId,
    clusterId,
    opts.status ?? "active",
  ]);
  return { clusterId, offerId, companyId };
}

export async function seedLead(
  db: Db,
  clusterId: string,
  fields: { companyId?: string; name?: string; email?: string; url?: string; status?: string; sampleUrl?: string } = {},
) {
  const id = newId("ld");
  await db.query(
    "insert into leads (id, cluster_id, company_id, name, email, url, external_id, status, sample_url) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      clusterId,
      fields.companyId ?? null,
      fields.name ?? "Folsom Street Dental",
      fields.email ?? null,
      fields.url ?? null,
      id,
      fields.status ?? "new",
      fields.sampleUrl ?? null,
    ],
  );
  return id;
}
