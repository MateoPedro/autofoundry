import { z } from "zod";
import { newId } from "../ids";
import { limit } from "./leads";
import { defineTool, ToolError } from "./tool";

// Channels agents can run end to end today. Add "x_reply" once X works (#13).
export const RUNNABLE_CHANNELS = ["contact_form", "email"];

const reason = z.string().trim().min(1).max(500);

export const listPending = defineTool({
  name: "list_pending",
  description:
    "Compliance only. Clusters and offers waiting for review, oldest first. Each cluster comes with up to 3 sample leads; each offer with every field.",
  input: z.object({ limit }),
  async run(ctx, input) {
    const clusters = await ctx.db.query<{ id: string; label: string; source: string; signal_count: number }>(
      "select id, label, source, signal_count from clusters where review_status = 'pending' order by created_at limit $1",
      [input.limit],
    );
    const withLeads = await Promise.all(
      clusters.map(async (c) => ({
        ...c,
        sample_leads: await ctx.db.query("select name, url, data from leads where cluster_id = $1 order by created_at limit 3", [c.id]),
      })),
    );
    const offers = await ctx.db.query(
      `select id, cluster_id, buyer, sample, product, price_cents, channel, outreach_message, follow_up_message, delivery, parent_offer_id
       from offers where review_status = 'pending' order by created_at limit $1`,
      [input.limit],
    );
    return { clusters: withLeads, offers };
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
