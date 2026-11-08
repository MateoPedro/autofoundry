import { fund, spawn } from "../../src/lib/server/foundry/company";
import { publishSample } from "../../src/lib/server/foundry/crew";
import type { ToolContext } from "../../src/lib/server/foundry/tool";
import { seedCrew } from "./crew";
import { FakeNaive } from "./fake-naive";
import { run, seedCluster, seedLead, seedOffer, testContext } from "./fixtures";

export async function setup(leads = 3) {
  const naive = new FakeNaive();
  const ctx = { ...(await testContext({ naive })), naive };
  await seedCrew(ctx);
  const clusterId = await seedCluster(ctx.db);
  const offerId = await seedOffer(ctx.db, clusterId);
  const leadIds = [];
  for (let i = 0; i < leads; i++) {
    const id = await seedLead(ctx.db, clusterId, { name: `Lead ${i}` });
    await ctx.db.query("update leads set created_at = $2 where id = $1", [id, new Date(Date.UTC(2026, 10, 7, 12, i))]);
    leadIds.push(id);
  }
  return { naive, ctx, clusterId, offerId, leadIds };
}

export const spawnArgs = (offerId: string, extra: Record<string, unknown> = {}) => ({
  request_id: "creator-2026-11-08T08:00-1",
  offer_id: offerId,
  reason: "3 leads, approved, nobody serving the cluster",
  ...extra,
});

export const page = (leadId: string) => `<!doctype html><title>${leadId}</title><p>Sample for ${leadId}</p>`;

export async function spawned(leads = 3) {
  const s = await setup(leads);
  const out = (await run(spawn, s.ctx, spawnArgs(s.offerId))) as { company_id: string; lead_ids: string[] };
  return { ...s, companyId: out.company_id, sampled: out.lead_ids };
}

// A company whose leads all have samples, waiting for VC.
export async function proposed(leads = 3) {
  const s = await spawned(leads);
  for (const leadId of s.sampled) await run(publishSample, s.ctx, { company_id: s.companyId, lead_id: leadId, agent_name: "creator", html: page(leadId) });
  return s;
}

export async function funded(leads = 3) {
  const s = await proposed(leads);
  await run(fund, s.ctx, { company_id: s.companyId, reason: "go" });
  return s;
}

export async function companyRow(ctx: ToolContext, id: string) {
  const [row] = await ctx.db.query<{ status: string; granted_micro_usd: unknown; funded_at: Date | null; killed_at: Date | null }>(
    "select status, granted_micro_usd, funded_at, killed_at from companies where id = $1",
    [id],
  );
  return { ...row, granted_micro_usd: Number(row.granted_micro_usd) };
}
