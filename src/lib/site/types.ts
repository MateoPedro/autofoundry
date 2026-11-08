// What the public site reads. Every number comes from the foundry database; the site never makes one
// up. Money stays in its source unit: micro-USD for grants and spend, cents for prices and revenue.
import type { CompanyStatus, Decision, Funnel } from "../dashboard/types";

export type SiteCompany = {
  id: string;
  slug: string;
  status: CompanyStatus;
  parent_id: string | null;
  // The offer's own product line, cut to its headline (see titleOf); no invented brand names.
  title: string;
  market: string;
  source: string;
  buyer: string;
  product: string;
  sample: string;
  delivery: string;
  outreach_message: string;
  price_cents: number;
  channel: string;
  spawned_at: string;
  funded_at: string | null;
  killed_at: string | null;
  granted_micro_usd: number;
  spend_micro_usd: number;
  revenue_cents: number;
  funnel: Funnel;
  failed_touches: number;
  sample_url: string | null;
  spawn_reason: string | null;
  fund_reason: string | null;
  kill_reason: string | null;
  // Every decision about this company, oldest first.
  decisions: Decision[];
  // The shared crew's sessions charged to this company, per agent.
  crew: { agent: string; micro_usd: number; sessions: number }[];
  touches: { agent: string; channel: string; kind: string; detail: string | null; at: string; lead: string | null }[];
  leads: { name: string; status: string; url: string | null; sample_url: string | null }[];
};

// An agent's deployed configuration: agents/<name>.agent.yaml and its prompt.
export type AgentProfile = { description: string; model: string; tools: string[]; prompt: string };

export type FeedbackNote = {
  id: string;
  kind: "note" | "summary";
  body: string;
  through_at: string;
  created_at: string;
  live: boolean;
};

// Scout's leads by the hour their market was found, split by how Outreach can reach them.
export type ChannelCycle = { at: string; email: number; form: number; other: number };

export type SiteAgent = {
  key: string;
  name: string;
  role: string;
  latest: string | null;
  at: string | null;
  active: boolean;
  spend_micro_usd: number | null;
  budget_micro_usd: number;
  // The agent's main output so far, e.g. 33 "markets found" for Scout.
  work: number;
  work_label: string;
};

export type SiteTotals = {
  markets: number;
  markets_approved: number;
  markets_rejected: number;
  companies: number;
  alive: number;
  killed: number;
  leads: number;
  samples: number;
  messages_sent: number;
  failed_touches: number;
  replies: number;
  payments: number;
  revenue_cents: number;
  spend_micro_usd: number;
  child_spend_micro_usd: number;
  granted_micro_usd: number;
  pool_micro_usd: number;
  killed_spend_micro_usd: number;
  median_minutes_to_kill: number | null;
};

export type Site =
  | {
      source: "live" | "snapshot";
      as_of: string;
      running: boolean | null;
      totals: SiteTotals;
      policy: { pool_micro_usd: number; grant_micro_usd: number; max_active: number; max_proposed: number; updated_at: string | null };
      companies: SiteCompany[];
      // Newest first.
      decisions: Decision[];
      feedback: FeedbackNote[];
      channels: ChannelCycle[];
      agents: SiteAgent[];
      labels: Record<string, string>;
    }
  | { source: "error"; message: string };

export type LiveSite = Extract<Site, { source: "live" | "snapshot" }>;
