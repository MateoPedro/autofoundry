import type { AgentRow, AgentsView } from "../../dashboard/types";
import { AGENT_ROLE, FOUNDRY_AGENTS, clip, usdFromMicro } from "../../dashboard/view";
import type { Db } from "../db";

const ACTIVE_MS = 3 * 60 * 60_000;

const DECIDED: Record<string, string> = { approve: "Approved", reject: "Rejected", spawn: "Spawned", fund: "Funded", kill: "Killed", hold: "Held" };
const TOUCHED: Record<string, string> = {
  sample_delivered: "Built a sample for",
  sent: "Messaged",
  failed: "Couldn't reach",
  reply_received: "Got a reply from",
  reply_sent: "Answered",
  delivered: "Delivered the product to",
};
const SOURCE: Record<string, string> = { github_issues: "GitHub issues", hackernews: "Hacker News", reddit: "Reddit", x_search: "X" };

type Event = { text: string; at: string } | null;

const iso = (value: Date | string) => new Date(value).toISOString();
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const newest = (...events: Event[]): Event => events.reduce<Event>((best, e) => (e && (!best || e.at > best.at) ? e : best), null);

type DecisionRow = { agent: string; kind: string; amount_micro_usd: unknown; at: Date; slug: string | null; cluster_label: string | null; product: string | null };

function decided(d: DecisionRow): Event {
  const target = d.slug ?? (d.product ? `the offer “${clip(d.product, 40)}”` : d.cluster_label ? `“${clip(d.cluster_label, 40)}”` : "");
  const amount = d.kind === "fund" && d.amount_micro_usd ? ` with ${usdFromMicro(Number(d.amount_micro_usd))}` : "";
  return { text: `${DECIDED[d.kind] ?? d.kind} ${target}${amount}`.trim(), at: iso(d.at) };
}

// What every agent last did, from the rows the foundry already keeps: decisions for Compliance, Creator
// and VC, leads, Monid reads and run pings for Scout, screens for Compliance, notes for Feedback, and
// touches for Creator's samples and for Outreach and the Closer. Spend is each agent's latest synced figure.
export async function agentActivity(db: Db, now: Date): Promise<AgentsView> {
  const decisions = await db.query<DecisionRow>(
    `select distinct on (d.agent) d.agent, d.kind, d.amount_micro_usd, d.at, co.slug, cl.label as cluster_label, o.product
     from decisions d
     left join companies co on co.id = d.company_id
     left join clusters cl on cl.id = d.cluster_id
     left join offers o on o.id = d.offer_id
     order by d.agent, d.at desc`,
  );
  const [lead] = await db.query<{ name: string; created_at: Date }>("select name, created_at from leads order by created_at desc limit 1");
  const [read] = await db.query<{ source: string; query: string; created_at: Date }>(
    "select source, query, created_at from monid_reads order by created_at desc limit 1",
  );
  const [ping] = await db.query<{ received_at: Date }>("select received_at from scout_pings order by received_at desc limit 1");
  const [screen] = await db.query<{ status: string; candidate_count: unknown; created_at: Date; finished_at: Date | null }>(
    "select status, candidate_count, created_at, finished_at from screens order by created_at desc limit 1",
  );
  const [note] = await db.query<{ kind: string; created_at: Date }>("select kind, created_at from scout_feedback order by created_at desc limit 1");
  const touches = await db.query<{ agent_name: string; kind: string; at: Date; lead_name: string | null }>(
    `select distinct on (t.agent_name) t.agent_name, t.kind, t.at, l.name as lead_name
     from touches t left join leads l on l.id = t.lead_id
     order by t.agent_name, t.at desc`,
  );
  const spend = await db.query<{ agent_id: string; agent_name: string; company_id: string | null; micro_usd: unknown; synced_at: Date }>(
    "select distinct on (agent_id) agent_id, agent_name, company_id, micro_usd, synced_at from spend order by agent_id, synced_at desc",
  );

  const byAgent = new Map(decisions.map((d) => [d.agent, decided(d)]));
  const touched = (agent: string): Event => {
    const t = touches.find((row) => row.agent_name === agent);
    return t ? { text: `${TOUCHED[t.kind] ?? t.kind}${t.lead_name ? ` ${t.lead_name}` : ""}`, at: iso(t.at) } : null;
  };
  const screened: Event = screen
    ? screen.status === "done"
      ? { text: `Screened ${num(screen.candidate_count)} ideas`, at: iso(screen.finished_at ?? screen.created_at) }
      : screen.status === "failed"
        ? { text: "A screen of new ideas failed", at: iso(screen.finished_at ?? screen.created_at) }
        : { text: `Screening ${num(screen.candidate_count)} ideas`, at: iso(screen.created_at) }
    : null;
  const latest: Record<keyof typeof FOUNDRY_AGENTS, Event> = {
    scout: newest(
      lead ? { text: `Saved a lead: ${clip(lead.name, 40)}`, at: iso(lead.created_at) } : null,
      read ? { text: `Searched ${SOURCE[read.source] ?? read.source} for “${clip(read.query, 40)}”`, at: iso(read.created_at) } : null,
      ping ? { text: "Finished a run", at: iso(ping.received_at) } : null,
    ),
    compliance: newest(byAgent.get("compliance") ?? null, screened),
    creator: newest(byAgent.get("creator") ?? null, touched("creator")),
    vc: byAgent.get("vc") ?? null,
    feedback: note
      ? { text: note.kind === "summary" ? "Summed up its notes for Scout" : "Wrote Scout a note on VC's latest call", at: iso(note.created_at) }
      : null,
    outreach: touched("outreach"),
    closer: touched("closer"),
  };
  const recency = (e: Event): AgentRow["status"] => (e && now.getTime() - Date.parse(e.at) < ACTIVE_MS ? "active" : "idle");

  const rows: AgentRow[] = (Object.keys(FOUNDRY_AGENTS) as (keyof typeof FOUNDRY_AGENTS)[]).map((key) => ({
    key,
    name: FOUNDRY_AGENTS[key],
    role: AGENT_ROLE[key],
    group: "Foundry",
    status: recency(latest[key]),
    latest: latest[key]?.text ?? null,
    at: latest[key]?.at ?? null,
    spend_micro_usd: num(spend.find((s) => s.company_id === null && s.agent_name === key)?.micro_usd),
  }));

  const [{ last }] = await db.query<{ last: Date | null }>("select max(synced_at) as last from spend");
  return { synced_at: last ? iso(last) : null, rows };
}

// Labels for the cluster and offer ids decisions point at, so the feed can name them.
export async function decisionTargets(db: Db, decisions: { cluster_id?: string | null; offer_id?: string | null }[]): Promise<Record<string, string>> {
  const clusters = [...new Set(decisions.map((d) => d.cluster_id).filter((id): id is string => !!id))];
  const offers = [...new Set(decisions.map((d) => d.offer_id).filter((id): id is string => !!id))];
  if (!clusters.length && !offers.length) return {};
  const rows = await db.query<{ id: string; label: string }>(
    "select id, label from clusters where id = any($1) union all select id, product as label from offers where id = any($2)",
    [clusters, offers],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.label]));
}
