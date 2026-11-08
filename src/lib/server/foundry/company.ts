import { z } from "zod";
import type { Db } from "../db";
import { newId } from "../ids";
import { SAMPLE_LEADS } from "./roles";
import { defineTool, ToolError } from "./tool";
import { closeCompanyWork, postPending, queue, requireNaive, WORK, type Work } from "./work";

const reason = z.string().trim().min(1).max(500);

type Company = { id: string; slug: string; status: string; offer_id: string; cluster_id: string };

// Finds the company for this request_id, or admits a new one under the policy and reserves its leads.
async function admit(db: Db, input: { request_id: string; offer_id: string; parent_id?: string | null; reason: string }) {
  return db.tx(async (tx) => {
    const [policy] = await tx.query<{ max_proposed: number }>("select max_proposed from funding_policy for update");
    const [existing] = await tx.query<Company>("select id, slug, status, offer_id, cluster_id from companies where request_id = $1", [input.request_id]);
    if (existing) {
      if (existing.offer_id !== input.offer_id) throw new ToolError("conflict", `request_id ${input.request_id} already spawned from offer ${existing.offer_id}`);
      return existing;
    }

    const [offer] = await tx.query<{ review_status: string; cluster_id: string }>("select review_status, cluster_id from offers where id = $1", [input.offer_id]);
    if (!offer) throw new ToolError("not_found", `no offer ${input.offer_id}`);
    if (offer.review_status !== "approved") throw new ToolError("not_approved", `offer ${input.offer_id} is ${offer.review_status}`);
    if (input.parent_id) {
      const [parent] = await tx.query("select 1 from companies where id = $1", [input.parent_id]);
      if (!parent) throw new ToolError("not_found", `no company ${input.parent_id}`);
    }
    const [{ waiting }] = await tx.query<{ waiting: unknown }>("select count(*) as waiting from companies where status in ('spawning', 'proposed')");
    if (Number(waiting) >= policy.max_proposed) {
      throw new ToolError("policy", `max_proposed: ${policy.max_proposed} companies are already waiting for funding`);
    }

    const [{ next }] = await tx.query<{ next: unknown }>(
      "select coalesce(max(substring(slug from 4)::int), 0) + 1 as next from companies where slug ~ '^co-[0-9]+$'",
    );
    const company: Company = {
      id: newId("co"),
      slug: `co-${String(next).padStart(2, "0")}`,
      status: "spawning",
      offer_id: input.offer_id,
      cluster_id: offer.cluster_id,
    };
    await tx.query("insert into companies (id, slug, offer_id, cluster_id, parent_id, status, request_id) values ($1, $2, $3, $4, $5, 'spawning', $6)", [
      company.id,
      company.slug,
      company.offer_id,
      company.cluster_id,
      input.parent_id ?? null,
      input.request_id,
    ]);
    const leads = await assignLeads(tx, company);
    if (!leads) throw new ToolError("invalid", `cluster ${company.cluster_id} has no leads that another company hasn't taken`);
    await tx.query("insert into decisions (id, agent, kind, cluster_id, offer_id, company_id, reason) values ($1, 'creator', 'spawn', $2, $3, $4, $5)", [
      newId("dc"),
      company.cluster_id,
      company.offer_id,
      company.id,
      input.reason,
    ]);
    return company;
  });
}

// Takes the cluster's oldest SAMPLE_LEADS leads that no company has.
async function assignLeads(db: Db, company: { id: string; cluster_id: string }): Promise<number> {
  const rows = await db.query(
    `update leads set company_id = $1, status = 'assigned'
     where id in (select id from leads where cluster_id = $2 and company_id is null and status = 'new'
                  order by created_at, id limit $3 for update skip locked)
     returning id`,
    [company.id, company.cluster_id, SAMPLE_LEADS],
  );
  return rows.length;
}

async function queueAll(db: Db, work: Work[], at: Date): Promise<string[]> {
  for (const w of work) await queue(db, w, at);
  return work.map((w) => w.key);
}

export const spawn = defineTool({
  name: "spawn",
  writes: true,
  description: `Creator only. Open a company from an approved offer. It takes the cluster's oldest ${SAMPLE_LEADS} leads that no company has and starts as spawning. Publish a sample for each of its lead_ids with publish_sample; once the last is published, the company is proposed and waits for VC. request_id is any string unique to this decision; calling again with it answers the same company.`,
  input: z.object({
    request_id: z.string().trim().min(1).max(200),
    offer_id: z.string().min(1),
    parent_id: z.string().min(1).nullish(),
    reason,
  }),
  async run(ctx, input) {
    const company = await admit(ctx.db, input);
    if (company.status === "killed") throw new ToolError("killed", `company ${company.id} from this request_id was killed`);
    const leads = await ctx.db.query<{ id: string }>("select id from leads where company_id = $1 order by created_at, id", [company.id]);
    return { company_id: company.id, slug: company.slug, status: company.status, lead_ids: leads.map((l) => l.id) };
  },
});

// The cards are written inside the transaction and sent to Naïve after it commits, so an agent never
// wakes to a grant that isn't there yet; one that fails to send waits for the sweep.
export const fund = defineTool({
  name: "fund",
  writes: true,
  description: `VC only. Grant one grant from the pool to a proposed or active company. The first grant makes the company active and hands each sampled lead to Outreach. A second or third grant adds the cluster's next ${SAMPLE_LEADS} leads and wakes Creator to sample them. Refused if it would pass the pool, the company's grant count, or max_active.`,
  input: z.object({ company_id: z.string().min(1), reason }),
  async run(ctx, input) {
    requireNaive(ctx);
    const { keys, ...result } = await ctx.db.tx(async (db) => {
      const [policy] = await db.query<{ pool_micro_usd: unknown; grant_micro_usd: unknown; max_grants_per_company: number; max_active: number }>(
        "select pool_micro_usd, grant_micro_usd, max_grants_per_company, max_active from funding_policy for update",
      );
      const [company] = await db.query<{ status: string; cluster_id: string; granted_micro_usd: unknown }>(
        "select status, cluster_id, granted_micro_usd from companies where id = $1 for update",
        [input.company_id],
      );
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is killed`);
      if (company.status !== "proposed" && company.status !== "active") {
        throw new ToolError("conflict", `company ${input.company_id} is ${company.status}; its samples have to be published before it can be funded`);
      }

      const pool = Number(policy.pool_micro_usd);
      const grant = Number(policy.grant_micro_usd);
      const [{ granted }] = await db.query<{ granted: unknown }>("select coalesce(sum(granted_micro_usd), 0) as granted from companies");
      const poolLeft = pool - Number(granted);
      if (grant > poolLeft) throw new ToolError("policy", `pool: a grant is ${grant} micro-USD and the pool has ${poolLeft} left`);
      const [{ grants }] = await db.query<{ grants: unknown }>("select count(*) as grants from decisions where company_id = $1 and kind = 'fund'", [input.company_id]);
      if (Number(grants) >= policy.max_grants_per_company) {
        throw new ToolError("policy", `max_grants_per_company: ${input.company_id} already has ${policy.max_grants_per_company} grants`);
      }
      const first = company.status === "proposed";
      if (first) {
        const [{ active }] = await db.query<{ active: unknown }>("select count(*) as active from companies where status = 'active'");
        if (Number(active) >= policy.max_active) throw new ToolError("policy", `max_active: ${policy.max_active} companies are already active`);
      }

      const total = Number(company.granted_micro_usd) + grant;
      await db.query("update companies set granted_micro_usd = $2, status = 'active', funded_at = coalesce(funded_at, now()) where id = $1", [
        input.company_id,
        total,
      ]);
      const decisionId = newId("dc");
      await db.query("insert into decisions (id, agent, kind, company_id, amount_micro_usd, reason) values ($1, 'vc', 'fund', $2, $3, $4)", [
        decisionId,
        input.company_id,
        grant,
        input.reason,
      ]);

      const work: Work[] = [];
      let leadsAdded = 0;
      if (first) {
        const leads = await db.query<{ id: string }>(
          `select l.id from leads l
           where l.company_id = $1 and l.sample_url is not null
             and not exists (select 1 from touches t where t.lead_id = l.id and t.kind = 'sent')
           order by l.created_at, l.id`,
          [input.company_id],
        );
        work.push(...leads.map((l) => WORK.contact(l.id, input.company_id)));
      } else {
        leadsAdded = await assignLeads(db, { id: input.company_id, cluster_id: company.cluster_id });
        if (leadsAdded) work.push(WORK.sample(input.company_id, Number(grants) + 1));
      }
      work.push(WORK.feedback(decisionId));
      return {
        company_id: input.company_id,
        status: "active",
        granted_micro_usd: total,
        pool_left_micro_usd: poolLeft - grant,
        leads_added: leadsAdded,
        keys: await queueAll(db, work, ctx.now()),
      };
    });
    return { ...result, work_created: await postPending(ctx, keys) };
  },
});

export const kill = defineTool({
  name: "kill",
  writes: true,
  description:
    "VC only. Kill a company with a one-line reason: it's marked killed, its open cards close so the crew does no more work for it, and Feedback gets the decision. If its cluster still has leads no company has, Creator is woken to consider a revised offer. Kill a proposed company you decide not to fund, so its slot frees. Its samples, leads and history stay, a buyer who already paid is still delivered, and unspent grant money doesn't return to the pool.",
  input: z.object({ company_id: z.string().min(1), reason }),
  async run(ctx, input) {
    requireNaive(ctx);
    const keys = await ctx.db.tx(async (db) => {
      const [company] = await db.query<{ status: string; cluster_id: string }>("select status, cluster_id from companies where id = $1 for update", [input.company_id]);
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is already killed`);

      await db.query("update companies set status = 'killed', killed_at = now() where id = $1", [input.company_id]);
      const decisionId = newId("dc");
      await db.query("insert into decisions (id, agent, kind, company_id, reason) values ($1, 'vc', 'kill', $2, $3)", [decisionId, input.company_id, input.reason]);
      const [unassigned] = await db.query("select 1 from leads where cluster_id = $1 and company_id is null and status = 'new' limit 1", [company.cluster_id]);
      return queueAll(db, [WORK.feedback(decisionId), ...(unassigned ? [WORK.revise(company.cluster_id, input.company_id)] : [])], ctx.now());
    });
    const cardsClosed = await closeCompanyWork(ctx, input.company_id);
    await postPending(ctx, keys);
    return { company_id: input.company_id, status: "killed", cards_closed: cardsClosed };
  },
});
