import { z } from "zod";
import { newId } from "../ids";
import { defineTool, ToolError } from "./tool";

// Channels agents can run end to end today. Add "x_reply" once X works (#13).
export const RUNNABLE_CHANNELS = ["contact_form", "email"];

const reason = z.string().trim().min(1).max(500);

export const listPending = defineTool({
  name: "list_pending",
  description:
    "Compliance only. Pending offers and clusters, oldest first, up to limit of each (default 3). Follow the independent next_cluster_id/next_offer_id cursors before writing reviews. Use review_context for saved lead evidence and contact routes.",
  input: z.object({
    limit: z.number().int().min(1).max(10).default(3),
    after_cluster_id: z.string().min(1).optional(),
    after_offer_id: z.string().min(1).optional(),
  }),
  async run(ctx, input) {
    const clusters = await ctx.db.query<{ id: string; label: string; source: string; signal_count: number }>(
      `select id, label, source, signal_count from clusters where review_status = 'pending'
       and ($2::text is null or (created_at, id) > (select created_at, id from clusters where id = $2))
       order by created_at, id limit $1`,
      [input.limit + 1, input.after_cluster_id ?? null],
    );
    const withLeads = await Promise.all(
      clusters.slice(0, input.limit).map(async (c) => ({
        ...c,
        sample_leads: await ctx.db.query("select name, url from leads where cluster_id = $1 order by created_at limit 3", [c.id]),
      })),
    );
    const offers = await ctx.db.query(
      `select id, cluster_id, buyer, sample, product, price_cents, channel, outreach_message, follow_up_message, delivery, parent_offer_id
       from offers where review_status = 'pending'
       and ($2::text is null or (created_at, id) > (select created_at, id from offers where id = $2))
       order by created_at, id limit $1`,
      [input.limit + 1, input.after_offer_id ?? null],
    );
    return { offers: offers.slice(0, input.limit), clusters: withLeads,
      next_cluster_id: clusters.length > input.limit ? clusters[input.limit - 1].id : null,
      next_offer_id: offers.length > input.limit ? offers[input.limit - 1].id : null };
  },
});

export const reviewContext = defineTool({
  name: "review_context",
  description: "Compliance only, read-only. Read a cluster's current review status and saved lead evidence/contact routes, plus one exact offer when offer_id is given. Follow next_lead_id to inspect more leads. signal_count counts stored leads, not verified demand. Reduce leads_limit if the result is too large; unavailable evidence stays pending.",
  input: z.object({
    cluster_id: z.string().min(1),
    offer_id: z.string().min(1).optional(),
    leads_limit: z.number().int().min(1).max(10).default(3),
    after_lead_id: z.string().min(1).optional(),
  }),
  async run(ctx, input) {
    const [cluster] = await ctx.db.query("select id, label, source, signal_count, unserved_score, review_status, review_reason from clusters where id = $1", [input.cluster_id]);
    if (!cluster) throw new ToolError("not_found", `no cluster ${input.cluster_id}`);
    const [offer] = input.offer_id ? await ctx.db.query("select * from offers where id = $1 and cluster_id = $2", [input.offer_id, input.cluster_id]) : [];
    if (input.offer_id && !offer) throw new ToolError("not_found", "no such offer in this cluster");
    const leads = await ctx.db.query<{ id: string }>(
      `select id, name, url, contact_url, email, external_id, data, company_id, status
       from leads where cluster_id = $1 and ($2::text is null or id > $2) order by id limit $3`,
      [input.cluster_id, input.after_lead_id ?? null, input.leads_limit + 1],
    );
    return { cluster, offer: offer ?? null, leads: leads.slice(0, input.leads_limit),
      next_lead_id: leads.length > input.leads_limit ? leads[input.leads_limit - 1].id : null };
  },
});

export const review = defineTool({
  name: "review",
  description:
    "Compliance only. Approve or reject one pending cluster or offer against the rules file, with a one-line reason. Every review is logged as a decision.",
  input: z.object({
    target: z.enum(["cluster", "offer"]),
    id: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    reason,
  }),
  async run(ctx, input) {
    const table = input.target === "cluster" ? "clusters" : "offers";
    const status = input.decision === "approve" ? "approved" : "rejected";
    return ctx.db.tx(async (db) => {
      const [row] = await db.query<{ review_status: string }>(`select review_status from ${table} where id = $1 for update`, [input.id]);
      if (!row) throw new ToolError("not_found", `no ${input.target} ${input.id}`);
      if (row.review_status !== "pending") throw new ToolError("conflict", `${input.target} ${input.id} is already ${row.review_status}`);
      await db.query(`update ${table} set review_status = $2, review_reason = $3 where id = $1`, [input.id, status, input.reason]);
      await db.query("insert into decisions (id, agent, kind, cluster_id, offer_id, reason) values ($1, 'compliance', $2, $3, $4, $5)", [
        newId("dc"),
        input.decision,
        input.target === "cluster" ? input.id : null,
        input.target === "offer" ? input.id : null,
        input.reason,
      ]);
      return { id: input.id, review_status: status };
    });
  },
});

export const proposeOffer = defineTool({
  name: "propose_offer",
  description:
    "Creator only. Submit an offer for an approved cluster: who buys, the free sample, the paid product, the price in cents (at least 50), the channel (contact_form or email), the exact messages, and how the product is delivered. outreach_message must include {{sample_url}}; use {{lead_name}} for the business's name. The offer waits for Compliance.",
  input: z.object({
    cluster_id: z.string().min(1),
    buyer: z.string().min(1).max(300),
    sample: z.string().min(1).max(500),
    product: z.string().min(1).max(500),
    price_cents: z.number().int().min(50),
    channel: z.string().min(1),
    outreach_message: z.string().min(1).max(2000),
    follow_up_message: z.string().min(1).max(2000).nullish(),
    delivery: z.string().min(1).max(500),
    parent_offer_id: z.string().min(1).nullish(),
  }),
  async run(ctx, input) {
    if (!RUNNABLE_CHANNELS.includes(input.channel)) {
      throw new ToolError("invalid", `channel must be one of ${RUNNABLE_CHANNELS.join(", ")}`);
    }
    if (!input.outreach_message.includes("{{sample_url}}")) {
      throw new ToolError("invalid", "outreach_message must include {{sample_url}} so replies can be matched to the lead");
    }
    const [cluster] = await ctx.db.query<{ review_status: string }>("select review_status from clusters where id = $1", [input.cluster_id]);
    if (!cluster) throw new ToolError("not_found", `no cluster ${input.cluster_id}`);
    if (cluster.review_status !== "approved") throw new ToolError("not_approved", `cluster ${input.cluster_id} is ${cluster.review_status}`);

    const offerId = newId("of");
    await ctx.db.query(
      `insert into offers (id, cluster_id, buyer, sample, product, price_cents, channel, outreach_message, follow_up_message, delivery, parent_offer_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        offerId,
        input.cluster_id,
        input.buyer,
        input.sample,
        input.product,
        input.price_cents,
        input.channel,
        input.outreach_message,
        input.follow_up_message ?? null,
        input.delivery,
        input.parent_offer_id ?? null,
      ],
    );
    return { offer_id: offerId, review_status: "pending" };
  },
});

export const logDecision = defineTool({
  name: "log_decision",
  description: "Creator or Funder. Record a hold: you reviewed and chose to do nothing, with a one-line reason.",
  input: z.object({
    agent: z.enum(["creator", "funder"]),
    kind: z.literal("hold"),
    company_id: z.string().min(1).nullish(),
    cluster_id: z.string().min(1).nullish(),
    reason,
  }),
  async run(ctx, input) {
    const decisionId = newId("dc");
    await ctx.db.query("insert into decisions (id, agent, kind, company_id, cluster_id, reason) values ($1, $2, 'hold', $3, $4, $5)", [
      decisionId,
      input.agent,
      input.company_id ?? null,
      input.cluster_id ?? null,
      input.reason,
    ]);
    return { decision_id: decisionId };
  },
});
