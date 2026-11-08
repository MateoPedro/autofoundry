// The shapes the dashboard reads: get_metrics and get_company as the foundry tools return them
// (docs/foundry-contract.md, sections 5 and 7). Money stays in its source unit: micro-USD for
// grants and spend, cents for revenue and prices.

export type CompanyStatus = "spawning" | "proposed" | "active" | "killed" | "failed";

export type Funnel = { leads: number; sampled: number; contacted: number; replied: number; paid: number };

export type CompanyEntry = {
  id: string;
  slug: string;
  status: CompanyStatus;
  offer_id: string;
  cluster_id: string;
  parent_id: string | null;
  offer_summary: string;
  spawned_at: string;
  funded_at: string | null;
  killed_at: string | null;
  granted_micro_usd: number;
  spend_micro_usd: number;
  revenue_cents: number;
  funnel: Funnel;
  touches_by_channel: Record<string, number>;
  cost_per_reply_micro_usd: number | null;
};

export type DecisionAgent = "compliance" | "creator" | "vc";
export type DecisionKind = "approve" | "reject" | "spawn" | "fund" | "kill" | "hold";

export type Decision = {
  id: string;
  agent: DecisionAgent;
  kind: DecisionKind;
  cluster_id?: string | null;
  offer_id?: string | null;
  company_id?: string | null;
  amount_micro_usd?: number | null;
  reason: string;
  at: string;
};

export type Metrics = {
  as_of: string;
  spend_stale?: boolean;
  spend_error?: string;
  policy: {
    pool_micro_usd: number;
    granted_micro_usd: number;
    pool_left_micro_usd: number;
    grant_micro_usd: number;
    max_proposed: number;
    max_active: number;
  };
  totals: {
    clusters: number;
    clusters_approved: number;
    offers: number;
    offers_approved: number;
    companies_proposed: number;
    companies_active: number;
    companies_killed: number;
    leads: number;
    touches: number;
    replies: number;
    payments: number;
    spend_micro_usd: number;
    revenue_cents: number;
  };
  companies: CompanyEntry[];
  decisions: Decision[];
};

export type Touch = { channel: string; kind: string; agent_name?: string; detail?: string | null; at: string };
export type Payment = { amount_cents: number; refunded_cents?: number; source?: string; livemode?: boolean; at: string };

export type CompanyLead = {
  id: string;
  name: string;
  status: string;
  url: string | null;
  sample_url: string | null;
  touches: Touch[];
  payments: Payment[];
};

export type Offer = {
  id: string;
  buyer: string;
  sample: string;
  product: string;
  price_cents: number;
  channel: string;
  outreach_message: string;
  follow_up_message: string | null;
  delivery: string;
};

export type CompanyDetail = {
  company: CompanyEntry;
  offer: Offer;
  leads: CompanyLead[];
  spend: { agent_name: string; micro_usd: number; synced_at: string }[];
};

// Where the numbers came from. "sample" is the contract's made-up response and must be labeled on screen.
export type Dashboard =
  | { source: "live" | "sample"; metrics: Metrics; focusId: string | null; detail: CompanyDetail | null }
  | { source: "error"; message: string };
