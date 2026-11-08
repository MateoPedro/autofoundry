import type { CompanyEntry, Decision, Metrics } from "./types";

// Unit conversion is explicit: micro-USD (1,000,000 = $1) for grants and spend, cents for revenue.
export function usdFromMicro(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

export function usdFromCents(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : `$${(cents / 100).toFixed(2)}`;
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export type LineageNode = {
  company: CompanyEntry;
  decisions: Decision[]; // oldest first, so the reasons read as a story
  children: LineageNode[];
};

// Companies arranged by parent_id. A company whose parent isn't in the list becomes a root,
// so a limited get_metrics page never drops a company from the tree.
export function buildLineage(companies: CompanyEntry[], decisions: Decision[]): LineageNode[] {
  const ids = new Set(companies.map((c) => c.id));
  const byCompany = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (!d.company_id) continue;
    byCompany.set(d.company_id, [...(byCompany.get(d.company_id) ?? []), d]);
  }
  const node = (company: CompanyEntry): LineageNode => ({
    company,
    decisions: [...(byCompany.get(company.id) ?? [])].sort((a, b) => a.at.localeCompare(b.at)),
    children: companies
      .filter((c) => c.parent_id === company.id)
      .sort((a, b) => a.spawned_at.localeCompare(b.spawned_at))
      .map(node),
  });
  return companies
    .filter((c) => !c.parent_id || !ids.has(c.parent_id))
    .sort((a, b) => a.spawned_at.localeCompare(b.spawned_at))
    .map(node);
}

// The company the deep dive shows: the one asked for by id or slug, else the best earner,
// else the most recently funded active one, else the newest.
export function pickFocus(companies: CompanyEntry[], requested?: string | null): CompanyEntry | null {
  if (requested) {
    const match = companies.find((c) => c.id === requested || c.slug === requested);
    if (match) return match;
  }
  if (companies.length === 0) return null;
  const earners = companies.filter((c) => c.revenue_cents > 0).sort((a, b) => b.revenue_cents - a.revenue_cents);
  if (earners[0]) return earners[0];
  const active = companies.filter((c) => c.status === "active").sort((a, b) => (b.funded_at ?? "").localeCompare(a.funded_at ?? ""));
  if (active[0]) return active[0];
  return [...companies].sort((a, b) => b.spawned_at.localeCompare(a.spawned_at))[0];
}

export function slugFor(metrics: Metrics, companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return metrics.companies.find((c) => c.id === companyId)?.slug ?? companyId;
}

export const KIND_LABEL: Record<Decision["kind"], string> = {
  approve: "Approved",
  reject: "Rejected",
  spawn: "Spawned",
  fund: "Funded",
  kill: "Killed",
  hold: "Held",
};

export const AGENT_LABEL: Record<Decision["agent"], string> = {
  compliance: "Compliance",
  creator: "Creator",
  vc: "VC",
};

export const FOUNDRY_AGENTS = { scout: "Scout", compliance: "Compliance", creator: "Creator", vc: "VC", feedback: "Feedback", outreach: "Outreach", closer: "Closer" } as const;

export const AGENT_ROLE: Record<string, string> = {
  scout: "Finds demand",
  compliance: "Checks demand and offers",
  creator: "Starts companies and builds samples",
  vc: "Funds and kills",
  feedback: "Tells Scout what sold",
  outreach: "Sends the first message",
  closer: "Answers replies",
};

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
