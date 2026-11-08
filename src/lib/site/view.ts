import type { SiteCompany } from "./types";

// The headline of an offer's product line: the words before its first colon, dash or parenthesis,
// without a leading article. "The complete sync engine design package: full spec…" → "Complete sync
// engine design package". The agents wrote it; the site only shortens it.
export function titleOf(product: string): string {
  const head = product.split(/\s*[:—–(]\s*|\s+-\s+|\.\s/)[0].trim();
  const bare = head.replace(/^(the|a|an|one)\s+/i, "").replace(/\s*,.*$/, "");
  const text = bare.length >= 8 ? bare : product;
  const short = text.length > 64 ? `${text.slice(0, 63).trimEnd()}…` : text;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

export const SOURCE_LABEL: Record<string, string> = {
  google_jobs: "Google Jobs",
  google_maps: "Google Maps",
  google_maps_dataforseo_audit: "Google Maps",
  google_reviews: "Google reviews",
  app_store: "App Store",
  app_store_reviews: "App Store reviews",
  reddit_x: "Reddit & X",
  reddit_hn: "Reddit & HN",
  github_issues: "GitHub issues",
};

export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source.replace(/_/g, " ");

export const CHANNEL_LABEL: Record<string, string> = { email: "Email", contact_form: "Contact form" };

export function money(micro: number, digits = 2): string {
  return `$${(micro / 1_000_000).toFixed(digits)}`;
}

export function price(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

export function pt(iso: string, withDay = false): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    ...(withDay ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

export function span(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// "1h 39m": the short form for a stat tile.
export function spanShort(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const m = minutes % 60;
  return m ? `${Math.floor(minutes / 60)}h ${m}m` : `${minutes / 60}h`;
}

export function ago(iso: string, now: string): string {
  const m = minutesBetween(iso, now);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export function lifespan(c: SiteCompany): number | null {
  return c.killed_at ? minutesBetween(c.spawned_at, c.killed_at) : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export const alive = (c: SiteCompany) => c.status === "active" || c.status === "proposed" || c.status === "spawning";

export function companyNumber(slug: string): string {
  const n = slug.match(/(\d+)$/)?.[1];
  return n ? n.padStart(2, "0") : slug;
}
