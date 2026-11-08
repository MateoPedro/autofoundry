import { z } from "zod";
import type { Db } from "../db";
import { newId } from "../ids";
import { webUrl } from "../../url";
import { defineTool, ToolError } from "./tool";

export const CHANNELS = ["contact_form", "email", "x_reply"] as const;
const TOUCH_KINDS = ["sample_delivered", "sent", "failed", "reply_received", "reply_sent", "delivered"] as const;
const LIVE_STATUSES = ["spawning", "proposed", "active"];
// A buyer can pay after a kill (spec, Money), so the Closer can still answer and deliver.
const AFTER_KILL: string[] = ["reply_received", "reply_sent", "delivered"];

const STATUS_RANK: Record<string, number> = { new: 0, assigned: 1, contacted: 2, replied: 3, paid: 4 };
const STATUS_AFTER: Partial<Record<(typeof TOUCH_KINDS)[number], string>> = {
  sample_delivered: "assigned",
  sent: "contacted",
  reply_received: "replied",
};

const optionalText = z.string().min(1).nullish();
const optionalWebUrl = z.string().min(1).refine((v) => webUrl(v) !== null, "must be a full http(s) URL").nullish();

// A spawning company waits for VC once each of its leads has a sample or a failed attempt at one.
export async function proposeIfSampled(db: Db, companyId: string): Promise<boolean> {
  const rows = await db.query(
    `update companies c set status = 'proposed'
     where c.id = $1 and c.status = 'spawning'
       and not exists (select 1 from leads l where l.company_id = c.id
                       and not exists (select 1 from samples s where s.lead_id = l.id)
                       and not exists (select 1 from touches t where t.lead_id = l.id and t.kind = 'failed'))
     returning c.id`,
    [companyId],
  );
  return rows.length > 0;
}

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
  writes: true,
  description:
    "Scout only. Save a demand cluster and the leads found for it. Creates the cluster by label (it starts pending Compliance review) or updates it, and skips leads already saved, matched by external_id or else url. url and contact_url must be full http(s) URLs.",
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
          url: optionalWebUrl,
          contact_url: optionalWebUrl,
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
  writes: false,
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
  writes: false,
  description:
    "Find a lead by lead_id (from a card title or a quoted sample link), or which lead sent a message, by email, url or name (case-insensitive). Leave out company_id to search every live company, plus paid buyers of killed ones; each lead says its company_id.",
  input: z.object({
    company_id: optionalText,
    lead_id: optionalText,
    email: optionalText,
    url: optionalText,
    name: optionalText,
  }),
  async run(ctx, input) {
    if (!input.lead_id && !input.email && !input.url && !input.name) throw new ToolError("invalid", "give at least one of lead_id, email, url or name");
    if (input.company_id) await requireCompany(ctx.db, input.company_id);
    const leads = await ctx.db.query(
      `select l.id, l.company_id, l.name, l.email, l.url, l.contact_url, l.status, l.sample_url from leads l
       join companies c on c.id = l.company_id
       where ($1::text is null and (c.status = any($6) or l.status = 'paid') or l.company_id = $1)
         and (l.id = $2 or lower(l.email) = lower($3) or l.url = $4 or lower(l.name) = lower($5))
       order by l.created_at limit 5`,
      [input.company_id ?? null, input.lead_id ?? null, input.email ?? null, input.url ? normalizeUrl(input.url) : null, input.name ?? null, LIVE_STATUSES],
    );
    return { leads };
  },
});

export const logTouch = defineTool({
  name: "log_touch",
  writes: true,
  description:
    "Record one piece of work on a lead: a sample delivered (detail = the sample's http(s) URL), a message sent or failed, a reply received or sent, a product delivered. Moves the lead's status forward. For a reply_received, message_id is the inbound email's inb_ id. A killed company still takes replies and deliveries, so a buyer who paid is served.",
  input: z.object({
    company_id: z.string().min(1),
    lead_id: z.string().min(1).nullish(),
    agent_name: z.string().min(1).max(100),
    channel: z.enum(CHANNELS),
    kind: z.enum(TOUCH_KINDS),
    detail: z.string().max(1000).nullish(),
    cost_micro_usd: z.number().int().min(0).default(0),
    message_id: z.string().min(1).max(200).nullish(),
  }).superRefine((touch, issues) => {
    if (touch.kind === "sample_delivered" && touch.detail != null && webUrl(touch.detail) === null) {
      issues.addIssue({ code: "custom", path: ["detail"], message: "a sample_delivered touch's detail must be the sample's full http(s) URL" });
    }
  }),
  async run(ctx, input) {
    return ctx.db.tx(async (db) => {
      const [company] = await db.query<{ status: string }>("select status from companies where id = $1 for share", [input.company_id]);
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed" && !AFTER_KILL.includes(input.kind)) {
        throw new ToolError("killed", `company ${input.company_id} is killed and takes no more work`);
      }

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
        `insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail, cost_micro_usd, message_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [touchId, input.company_id, input.lead_id ?? null, input.agent_name, input.channel, input.kind, input.detail ?? null, input.cost_micro_usd, input.message_id ?? null],
      );
      if (input.kind === "failed") await proposeIfSampled(db, input.company_id);
      return { touch_id: touchId, lead_status: leadStatus };
    });
  },
});

export const dismissInbound = defineTool({
  name: "dismiss_inbound",
  writes: true,
  description:
    "Closer only. Mark an email to the shared inbox handled without a lead: spam, an auto-reply, or a sender no lead matches. message_id is its inb_ id; reason is one line. The sweep then never hands it to you again.",
  input: z.object({ message_id: z.string().min(1).max(200), reason: z.string().trim().min(1).max(200) }),
  async run(ctx, input) {
    await ctx.db.query("insert into inbound_seen (message_id, outcome) values ($1, $2) on conflict (message_id) do nothing", [input.message_id, input.reason]);
    return { message_id: input.message_id, dismissed: true };
  },
});
