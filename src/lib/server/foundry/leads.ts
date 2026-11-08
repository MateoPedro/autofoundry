import { z } from "zod";
import type { Db } from "../db";
import { newId } from "../ids";
import { defineTool, ToolError } from "./tool";

export const CHANNELS = ["contact_form", "email", "x_reply"] as const;
const TOUCH_KINDS = ["sample_delivered", "sent", "failed", "reply_received", "reply_sent", "delivered"] as const;
const LIVE_STATUSES = ["spawning", "proposed", "active"];

const STATUS_RANK: Record<string, number> = { new: 0, assigned: 1, contacted: 2, replied: 3, paid: 4 };
const STATUS_AFTER: Partial<Record<(typeof TOUCH_KINDS)[number], string>> = {
  sample_delivered: "assigned",
  sent: "contacted",
  reply_received: "replied",
};

const optionalText = z.string().min(1).nullish();

export async function requireCompany(db: Db, companyId: string) {
  const [company] = await db.query<{ id: string; status: string }>("select id, status from companies where id = $1", [companyId]);
  if (!company) throw new ToolError("not_found", `no company ${companyId}`);
  return company;
}

// The same business can show up as https://www.Biz.example/ and https://biz.example#contact.
// One normal form per site keeps it from being contacted twice.
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const host = url.host.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}${path}${url.search}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

function advance(current: string, target: string | undefined) {
  if (!target || current === "dead") return current;
  return STATUS_RANK[target] > (STATUS_RANK[current] ?? 0) ? target : current;
}

export const addLeads = defineTool({
  name: "add_leads",
  description:
    "Scout only. Save a demand cluster and the leads found for it. Creates the cluster by label (it starts pending Compliance review) or updates it, and skips leads already saved, matched by external_id or else url.",
  input: z.object({
    cluster: z.object({
      label: z.string().min(1).max(200),
      source: z.string().min(1).max(50),
      unserved_score: z.number().min(0).max(1).default(0),
    }),
    leads: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          url: optionalText,
          contact_url: optionalText,
          email: optionalText,
          external_id: optionalText,
          data: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .max(100),
  }),
  async run(ctx, { cluster, leads }) {
    return ctx.db.tx(async (db) => {
      const [row] = await db.query<{ id: string; review_status: string }>(
        `insert into clusters (id, label, source, unserved_score) values ($1, $2, $3, $4)
         on conflict (label) do update set unserved_score = excluded.unserved_score, updated_at = now()
         returning id, review_status`,
        [newId("cl"), cluster.label, cluster.source, cluster.unserved_score],
      );
      let added = 0;
      let skipped = 0;
      for (const lead of leads) {
        const url = lead.url ? normalizeUrl(lead.url) : null;
        const key = lead.external_id ?? url;
        const seenUrl = url ? await db.query("select 1 from leads where cluster_id = $1 and (url = $2 or external_id = $2)", [row.id, url]) : [];
        if (!key || seenUrl.length) {
          skipped++;
          continue;
        }
        const inserted = await db.query(
          `insert into leads (id, cluster_id, name, url, contact_url, email, external_id, data)
           values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (cluster_id, external_id) do nothing returning id`,
          [newId("ld"), row.id, lead.name, url, lead.contact_url ?? null, lead.email ?? null, key, lead.data],
        );
        if (inserted.length) added++;
        else skipped++;
      }
      const [count] = await db.query<{ signal_count: number }>(
        "update clusters set signal_count = (select count(*) from leads where cluster_id = $1) where id = $1 returning signal_count",
        [row.id],
      );
      return { cluster_id: row.id, added, skipped, signal_count: count.signal_count, review_status: row.review_status };
    });
  },
});

export const listClusters = defineTool({
  name: "list_clusters",
  description:
    "List demand clusters, biggest first. company_ids lists the live companies serving each one; unserved_only keeps clusters with none.",
  input: z.object({
    review_status: z.enum(["pending", "approved", "rejected"]).optional(),
    unserved_only: z.boolean().default(false),
    min_signal_count: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(30).default(20),
  }),
  async run(ctx, input) {
    const rows = await ctx.db.query<{
      id: string;
      label: string;
      source: string;
      signal_count: number;
      unserved_score: number;
      review_status: string;
      company_ids: string[];
    }>(
      `select c.id, c.label, c.source, c.signal_count, c.unserved_score, c.review_status,
              coalesce(array_agg(co.id order by co.spawned_at) filter (where co.id is not null), '{}') as company_ids
       from clusters c
       left join companies co on co.cluster_id = c.id and co.status = any($1)
       where ($2::text is null or c.review_status = $2) and c.signal_count >= $3
       group by c.id
       having not $4 or count(co.id) = 0
       order by c.signal_count desc, c.created_at
       limit $5`,
      [LIVE_STATUSES, input.review_status ?? null, input.min_signal_count, input.unserved_only, input.limit],
    );
    return { clusters: rows.map((r) => ({ ...r, unserved_score: Number(r.unserved_score) })) };
  },
});

export const findLead = defineTool({
  name: "find_lead",
  description:
    "Find which of a company's leads sent a message, by email, url or name (case-insensitive). Use the lead id from a quoted sample link when there is one.",
  input: z.object({
    company_id: z.string().min(1),
    email: optionalText,
    url: optionalText,
    name: optionalText,
  }),
  async run(ctx, input) {
    if (!input.email && !input.url && !input.name) throw new ToolError("invalid", "give at least one of email, url or name");
    await requireCompany(ctx.db, input.company_id);
    const leads = await ctx.db.query(
      `select id, name, email, url, status, sample_url from leads
       where company_id = $1 and (lower(email) = lower($2) or url = $3 or lower(name) = lower($4))
       order by created_at limit 5`,
      [input.company_id, input.email ?? null, input.url ? normalizeUrl(input.url) : null, input.name ?? null],
    );
    return { leads };
  },
});

export const logTouch = defineTool({
  name: "log_touch",
  description:
    "Record one piece of work on a lead: a sample delivered (detail = the sample URL), a message sent or failed, a reply received or sent, a product delivered. Moves the lead's status forward.",
  input: z.object({
    company_id: z.string().min(1),
    lead_id: z.string().min(1).nullish(),
    agent_name: z.string().min(1).max(100),
    channel: z.enum(CHANNELS),
    kind: z.enum(TOUCH_KINDS),
    detail: z.string().max(1000).nullish(),
    cost_micro_usd: z.number().int().min(0).default(0),
  }),
  async run(ctx, input) {
    return ctx.db.tx(async (db) => {
      const [company] = await db.query<{ status: string }>("select status from companies where id = $1 for share", [input.company_id]);
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is killed and takes no more work`);

      let leadStatus: string | null = null;
      if (input.lead_id) {
        const [lead] = await db.query<{ status: string }>("select status from leads where id = $1 and company_id = $2 for update", [
          input.lead_id,
          input.company_id,
        ]);
        if (!lead) throw new ToolError("not_found", `no lead ${input.lead_id} in company ${input.company_id}`);
        leadStatus = advance(lead.status, STATUS_AFTER[input.kind]);
        const sampleUrl = input.kind === "sample_delivered" ? (input.detail ?? null) : null;
        await db.query("update leads set status = $2, sample_url = coalesce($3, sample_url) where id = $1", [input.lead_id, leadStatus, sampleUrl]);
      }

      const touchId = newId("tc");
      await db.query(
        `insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail, cost_micro_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [touchId, input.company_id, input.lead_id ?? null, input.agent_name, input.channel, input.kind, input.detail ?? null, input.cost_micro_usd],
      );
      return { touch_id: touchId, lead_status: leadStatus };
    });
  },
});
