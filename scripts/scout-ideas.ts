import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VettaClient } from "@usenaive-sdk/managed-agents";

import { monidClient, READ_SOURCES } from "./monid-client";

// Nine cheap, deterministic source pipelines run in parallel and each proposes 2..5 ideas for one of
// three buyer types: businesses (B2B), consumers (B2C) or AI agents and their builders (B2A).
// No LLM: provider data is filtered by fixed rules, so a pass takes about a minute and costs a few
// cents. Naïve data tools supply most sources; Monid supplies GitHub, Hacker News and cheap Reddit
// reads through a fixed allowlist. Ideas are candidates for review; this module never writes to
// Foundry and never contacts anyone.

export type Pipeline = "maps" | "reviews" | "appstore" | "jobs" | "reddit" | "consumer_posts" | "app_wishes" | "agent_github" | "agent_forums";
export type Buyer = "business" | "consumer" | "agent";
export const BUYER: Record<Pipeline, Buyer> = { maps: "business", reviews: "business", appstore: "business", jobs: "business", reddit: "business",
  consumer_posts: "consumer", app_wishes: "consumer", agent_github: "agent", agent_forums: "agent" };
export type SignalType = "inferred_gap" | "explicit_request" | "repeated_pain";
export type Lead = { name: string; url: string | null; contact_url: string | null; email: string | null; external_id: string;
  data: { evidence: { url: string; observation: string }[]; issues: string[]; observed_at: string; discovery_query: string; signal_type: SignalType; contact_verified: boolean;
    buyer_type?: Buyer; channel?: string; revenue?: Revenue } };
export type Evidence = { url: string; observation: string };
// How an idea makes money: who pays, for what, how, and through which channel we reach them.
// channel_ready is true only for channels the plan can run today (contact_form, email).
export type Revenue = { payer: string; offer: string; model: "one_time" | "monthly" | "per_call"; price_usd: number; channel: string; channel_ready: boolean; note?: string };
// Consumer and agent ideas carry evidence but no leads: we never store individual consumers, and
// forum posters are demand signals, not contactable buyers.
export type Idea = { pipeline: Pipeline; buyer?: Buyer; revenue?: Revenue; kind: string; rank: number; cluster: { label: string; source: string; unserved_score: number };
  leads: Lead[]; why: string };
export type IdeasRun = { request_id: string; area: string; started_at: string; finished_at: string; spent_micro_usd: number;
  ideas: Idea[]; per_pipeline: Record<Pipeline, number>; notes: string[] };

export const RUN_CAP_MICRO_USD = 60_000; // $0.06 hard ceiling on quoted source spend per pass
export const PER_PIPELINE = { min: 2, max: 5 };
export const TOTAL_MAX = 20;

export type Scope = { area: string; categories: string[]; appTerms: string[]; jobKeywords: string[]; redditQueries: string[];
  consumerQueries: string[]; consumerXQueries: string[]; consumerAppTerms: string[]; agentIssueQueries: string[]; agentForumQueries: string[]; agentHnQueries: string[] };
export const DEFAULT_SCOPE: Scope = {
  area: "Mission District, San Francisco, CA",
  categories: ["plumber", "dentist", "hair salon", "auto repair", "restaurant", "cafe"],
  appTerms: ["salon booking", "restaurant ordering", "gym class booking", "church app", "pet grooming", "tutoring"],
  jobKeywords: ["part time social media coordinator", "bookkeeper part time", "freelance website designer", "part time content writer", "virtual assistant small business"],
  redditQueries: [
    "subreddit:smallbusiness AND (website OR \"google reviews\" OR booking)",
    "subreddit:smallbusiness AND (\"social media\" OR bookkeeping OR invoices)",
    "subreddit:restaurateur AND (website OR menu OR \"online ordering\" OR reviews)",
    "subreddit:Entrepreneur AND (\"looking for\" OR \"need help\") AND (website OR marketing OR automation)",
    "subreddit:sweatystartup AND (website OR reviews OR booking OR quotes OR invoices)",
    "subreddit:smallbusiness AND (\"looking for\" OR recommend) AND (software OR service OR freelancer)",
    "subreddit:shopify AND (help OR need) AND (store OR translation OR product descriptions)",
    "subreddit:smallbusiness AND (newsletter OR \"email list\" OR \"google business profile\")",
  ],
  consumerQueries: [
    "\"is there an app\" OR \"wish there was an app\"",
    "\"looking for an app\" OR \"any app that\"",
    "\"is there a website\" OR \"wish there was a website\"",
    "subreddit:apps \"looking for\"",
    "subreddit:productivity (\"is there an app\" OR \"looking for an app\")",
    "subreddit:personalfinance (\"is there an app\" OR \"looking for an app\")",
  ],
  consumerXQueries: [
    "(\"is there an app\" OR \"wish there was an app\") -filter:replies lang:en",
    "(\"looking for an app\" OR \"need an app\") -filter:replies lang:en",
    "(\"is there a website\" OR \"wish there was a website\") -filter:replies lang:en",
  ],
  consumerAppTerms: ["budget", "meal planner", "habit tracker", "language learning", "sleep tracker", "to do list"],
  agentIssueQueries: [
    "\"mcp server\" is:issue is:open in:title",
    "(\"mcp support\" OR \"mcp integration\") is:issue is:open in:title",
    "(\"ai agent\" OR \"ai agents\" OR \"llm agent\") (api OR integration OR support) is:issue is:open in:title",
  ],
  agentForumQueries: [
    "subreddit:mcp (\"is there\" OR \"looking for\" OR \"need\")",
    "subreddit:AI_Agents (\"is there\" OR \"looking for\" OR \"need a tool\")",
    "subreddit:ClaudeAI (\"mcp for\" OR \"is there an mcp\")",
    "subreddit:n8n (\"is there a node\" OR \"looking for\" OR integration)",
    "subreddit:LocalLLaMA (\"is there a tool\" OR \"looking for\") agent",
  ],
  agentHnQueries: ["Ask HN MCP server", "Ask HN AI agent tool", "Ask HN agent API"],
};

// ---------- pure classifiers (unit tested) ----------

const BUILDER_HOSTS = /(^|\.)(facebook\.com|instagram\.com|yelp\.com|linktr\.ee|business\.site|wixsite\.com|godaddysites\.com|square\.site|carrd\.co|sites\.google\.com|weebly\.com)$/i;
export function mapsGaps(listing: { website?: string | null; operating_hours?: unknown; reviews?: number }) {
  const gaps: string[] = [];
  if (!listing.website) gaps.push("no_website");
  else {
    try {
      const u = new URL(listing.website);
      if (BUILDER_HOSTS.test(u.hostname)) gaps.push("social_or_builder_site");
      else if (u.protocol === "http:") gaps.push("http_link");
    } catch { gaps.push("no_website"); }
  }
  if (!listing.operating_hours) gaps.push("no_hours");
  return gaps;
}
export const GAP_TEXT: Record<string, string> = {
  no_website: "have no website on their Google listing",
  social_or_builder_site: "use a social page or free site builder as their website",
  http_link: "link an http:// (not https) site from their listing",
  no_hours: "have no opening hours on their Google listing",
};

// Customer complaints an agent-built digital deliverable could address.
export const PAINS: Record<string, { re: RegExp; text: string }> = {
  phone: { re: /(never|didn'?t|don'?t|doesn'?t|no one|nobody)\s+(answer|pick(ed)? up|call(ed)? (me )?back|return(ed)? (my )?call)|voicemail|impossible to reach|can'?t (get|reach) (a hold of|anyone|through)/i, text: "customers say calls go unanswered" },
  booking: { re: /(online|book(ing)?|schedul(e|ing)|appointment)[^.]{0,40}(online|website|system|app)[^.]{0,30}(didn'?t|doesn'?t|broken|wrong|cancel|no record|lost)|no online (booking|scheduling)|couldn'?t book/i, text: "customers report booking/scheduling failures" },
  hours: { re: /(hours|open)[^.]{0,40}(wrong|incorrect|inaccurate|not updated|outdated)|said (they were|it was) open|showed up[^.]{0,40}closed|closed (early|when)/i, text: "customers found the posted hours wrong" },
  website: { re: /(website|site|menu online|online menu)[^.]{0,40}(outdated|wrong|broken|down|doesn'?t work|not working|old|no prices)/i, text: "customers say the website/menu is outdated or broken" },
  ordering: { re: /(online order(ing)?|order(ed)? online|doordash|ubereats|uber eats|grubhub)[^.]{0,60}(wrong|missing|cancel|never|late|cold)/i, text: "customers report online-ordering problems" },
  communication: { re: /(no|never got( a)?|didn'?t get( a)?) (response|reply|follow[- ]?up|confirmation|estimate|quote)|ignored (my|our) (email|message)s?|ghost(ed|ing)|never heard back|no one (got|called) back/i, text: "customers say emails/quotes go unanswered" },
  pricing: { re: /(quote|estimate|price|bill|invoice)[^.]{0,60}(higher|different|changed|doubled|tripled|hidden|surprise|not what)|upsell|hidden (fee|charge)s?|bait and switch/i, text: "customers complain about surprise pricing or unclear quotes" },
};
export function reviewPains(text: string) { return Object.entries(PAINS).filter(([, p]) => p.re.test(text)).map(([k]) => k); }

export function appSignals(app: { supported_languages?: string[]; rating?: { count: number; rating: number }[]; latest_version_release_date?: string }, now: Date) {
  const count = app.rating?.[0]?.count ?? 0;
  const stars = app.rating?.[0]?.rating ?? 0;
  const signals: string[] = [];
  // Has real users but is not a giant; giants localize themselves and won't buy a $49 pack.
  if (count < 20 || count > 50_000) return signals;
  const langs = app.supported_languages ?? [];
  if (langs.length === 1 && langs[0] === "EN") signals.push("english_only");
  const updated = Date.parse((app.latest_version_release_date ?? "").replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isFinite(updated) && now.getTime() - updated > 365 * 86_400_000) signals.push("stale_listing");
  if (stars > 0 && stars < 3.5) signals.push("low_rating");
  return signals;
}
// Stronger, more actionable gaps rank first when ideas tie on score.
export const GAP_RANK: Record<string, number> = { no_website: 3, social_or_builder_site: 3, no_hours: 2, http_link: 1 };
export const APP_TEXT: Record<string, string> = {
  english_only: "ship an English-only App Store listing despite an established user base",
  stale_listing: "have not updated their listing in over a year",
  low_rating: "have ratings under 3.5 stars from real users",
};

export const TASKS: Record<string, { re: RegExp; text: string }> = {
  social_media: { re: /social media|instagram|tiktok|content creator/i, text: "social media content" },
  bookkeeping: { re: /bookkeep|quickbooks|accounts (payable|receivable)|invoic/i, text: "bookkeeping and invoicing" },
  website: { re: /web(site)? (design|develop)|wordpress|shopify|squarespace|landing page|\bwebsite\b/i, text: "website design and updates" },
  writing: { re: /content writer|copywrit|blog|newsletter/i, text: "copywriting and newsletters" },
  admin: { re: /virtual assistant|data entry|admin(istrative)? assistant|scheduling|inbox/i, text: "admin, data entry and scheduling" },
  reviews: { re: /google reviews|yelp reviews|online reviews|reputation/i, text: "online reviews and reputation" },
  marketing: { re: /\bmarketing\b|\bseo\b|google ads|lead gen/i, text: "marketing and SEO" },
};
export function taskOf(text: string) { return Object.entries(TASKS).find(([, t]) => t.re.test(text))?.[0] ?? null; }
const AGENCY = /staffing|recruit|talent|robert half|randstad|adecco|aquent|confidential|\bjobs?\b|career|writer remote|jobleads|\bhire\b|remote quest/i;
export function isSmallEmployer(name: string) { return !!name.trim() && !AGENCY.test(name); }
// Sellers pitching services in owner forums are noise, not demand.
const SELLER = /\b(i'?m|i am|we'?re|we are) (building|offering|a freelance|an? (agency|developer|designer|consultant))|\bi (build|offer|made|created|help)\b|\bwe (build|offer|help)\b|dm me|hire me|for hire|my (agency|service|platform|app|tool)|freelance (developer|designer)|feedback friday|rate my|promot|check out|your (business|company|restaurant)/i;
const FIRST_PERSON = /\b(i|my|we|our)\b/i;
const ASK = /\b(need help|looking for|recommend|anyone (use|know|tried)|how do (i|you)|struggl|can'?t (keep up|figure)|overwhelmed|hire|outsourc|tool for)\b/i;
export function redditTask(title: string, body: string) {
  // The ask must be up front and in the owner's own voice; then classify the whole post.
  title = title.replace(/[\u2018\u2019]/g, "'"); body = body.replace(/[\u2018\u2019]/g, "'");
  const head = `${title}\n${body.slice(0, 400)}`;
  if (SELLER.test(head) || !ASK.test(head) || !FIRST_PERSON.test(head)) return null;
  return taskOf(`${title}\n${body.slice(0, 1500)}`);
}

// Each lead earns 0.2 for an observed gap, or 0.5 for a direct request, plus 0.1 if >=3 independent
// businesses share the problem. No contact route is verified yet, so that 0.2 is never added here.
export function score(signal: SignalType, leads: number) {
  const base = signal === "explicit_request" ? 0.5 : 0.2;
  return Math.round(Math.min(1, base + (leads >= 3 ? 0.1 : 0)) * 100) / 100;
}

export function pickIdeas(byPipeline: Partial<Record<Pipeline, Idea[]>>) {
  // Best first, but take one idea per kind (gap/pain/task) before repeating a kind, so a pipeline's
  // five ideas are not the same finding in five categories.
  const ranked = (ideas: Idea[]) => {
    const sorted = [...ideas].sort((a, b) => b.cluster.unserved_score - a.cluster.unserved_score || b.rank - a.rank || b.leads.length - a.leads.length);
    const seen = new Set<string>();
    const fresh = sorted.filter(i => !seen.has(i.kind) && seen.add(i.kind));
    return [...fresh, ...sorted.filter(i => !fresh.includes(i))];
  };
  const picked: Record<Pipeline, Idea[]> = Object.fromEntries(Object.entries(byPipeline).map(([p, ideas]) => [p, ranked(ideas).slice(0, PER_PIPELINE.max)])) as Record<Pipeline, Idea[]>;
  // Trim the deepest pipelines first so no pipeline drops below the minimum to make room.
  let total = Object.values(picked).reduce((n, i) => n + i.length, 0);
  while (total > TOTAL_MAX) {
    const [p] = Object.entries(picked).sort((a, b) => b[1].length - a[1].length)[0];
    if (picked[p as Pipeline].length <= PER_PIPELINE.min) break;
    picked[p as Pipeline].pop(); total--;
  }
  for (const ideas of Object.values(picked)) ideas.sort((a, b) => b.cluster.unserved_score - a.cluster.unserved_score || b.rank - a.rank);
  return picked;
}

// Group observations into ideas: one idea per (key) with at least `min` distinct businesses.
function group<T>(items: T[], key: (t: T) => string | null, id: (t: T) => string, min = 2) {
  const groups = new Map<string, Map<string, T>>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, new Map());
    groups.get(k)!.set(id(item), item); // dedupe within a group by source ID
  }
  return [...groups].filter(([, g]) => g.size >= min).map(([k, g]) => [k, [...g.values()].slice(0, 10)] as const);
}
function cleanUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try { const u = new URL(raw); for (const p of [...u.searchParams.keys()]) if (/^(utm_|cid$|gclid|fbclid)/i.test(p)) u.searchParams.delete(p); u.hash = ""; return u.href; } catch { return null; }
}

// ---------- provider access with a spending guard ----------

type Expect = { name: string; search: string; maxQuoteMicroUsd: number; worstCaseMicroUsd: number };
export const TOOLS = {
  maps: { name: "Search Google Maps", search: "google maps reviews", maxQuoteMicroUsd: 150, worstCaseMicroUsd: 150 },
  googleReviews: { name: "Get Google Reviews", search: "google maps reviews", maxQuoteMicroUsd: 150, worstCaseMicroUsd: 150 },
  yelpSearch: { name: "Search Yelp", search: "business reviews yelp", maxQuoteMicroUsd: 150, worstCaseMicroUsd: 150 },
  yelpReviews: { name: "Get Yelp Reviews", search: "yelp reviews", maxQuoteMicroUsd: 150, worstCaseMicroUsd: 150 },
  appstore: { name: "Search App Store", search: "app store search", maxQuoteMicroUsd: 150, worstCaseMicroUsd: 150 },
  // Quoted 1,200 per call but billed 2,400 for depth 10 on Nov 7; budget the observed amount.
  jobs: { name: "Google Jobs Results", search: "google jobs", maxQuoteMicroUsd: 1200, worstCaseMicroUsd: 2400 },
  reddit: { name: "/api/v1/reddit/app/fetch_dynamic_search", search: "reddit search posts", maxQuoteMicroUsd: 1000, worstCaseMicroUsd: 1000 },
  appReviews: { name: "Get App Store Reviews", search: "app store reviews", maxQuoteMicroUsd: 150, worstCaseMicroUsd: 150 },
} satisfies Record<string, Expect>;

export type MonidReader = Pick<ReturnType<typeof monidClient>, "readSource" | "getRun">;
type MonidRun = { runId?: string; status?: string; providerResponse?: { httpStatus?: number }; cost?: { value?: number }; billing?: { reportedCost?: { value?: number } }; output?: { data?: unknown } };

export class Sources {
  spent = 0;
  reserved = 0;
  notes: string[] = [];
  private ids = new Map<string, Promise<string>>();
  constructor(private client: Pick<VettaClient, "data">, private cap = RUN_CAP_MICRO_USD, private monidReader: MonidReader | null = null) {}

  // Fixed Monid read endpoints only (see READ_SOURCES). Monid runs are billed once started, so a
  // failed or lost run is never retried; an existing run is polled instead.
  async monid(name: keyof typeof READ_SOURCES, body: Record<string, unknown>): Promise<unknown | null> {
    const what = `Monid ${name} (${String(Object.values(body)[0] ?? "").slice(0, 60)})`;
    if (!this.monidReader) { this.notes.push(`${what} skipped: MONID_API_KEY is not configured.`); return null; }
    const worst = READ_SOURCES[name].maxMicroUsd;
    if (this.spent + this.reserved + worst > this.cap) { this.notes.push(`Skipped ${what}: run cap ${this.cap} micro-USD reached.`); return null; }
    this.reserved += worst;
    try {
      let r = await this.monidReader.readSource(name, body) as MonidRun;
      for (let i = 0; r.status === "RUNNING" && r.runId && i < 15; i++) { await new Promise(x => setTimeout(x, 2000)); r = await this.monidReader.getRun(r.runId) as MonidRun; }
      const cost = r.billing?.reportedCost?.value ?? Math.round((r.cost?.value ?? (r.status === "COMPLETED" ? worst / 1_000_000 : 0)) * 1_000_000);
      this.spent += cost;
      const http = r.providerResponse?.httpStatus ?? 0;
      if (r.status !== "COMPLETED" || http < 200 || http >= 300) { this.notes.push(`${what} ${r.status ?? "unknown"} (HTTP ${http}, run ${r.runId ?? "n/a"}); not retried.`); return null; }
      return r.output?.data ?? null;
    } catch (error) {
      this.notes.push(`${what} errored without a receipt (${error instanceof Error ? error.message.slice(0, 120) : "unknown"}); check Monid run history, not retried.`);
      return null;
    } finally { this.reserved -= worst; }
  }

  private toolId(t: Expect) {
    // Tool IDs are ephemeral: discover once per pass, verify name and price, never cache across passes.
    if (!this.ids.has(t.name)) this.ids.set(t.name, (async () => {
      const found = await this.client.data.searchTools({ query: t.search, limit: 10 });
      const tool = found.data.find(x => x.name === t.name);
      if (!tool) throw new Error(`${t.name} is not in the catalog`);
      if (tool.price.basis !== "per_call" || tool.price.micro_usd > t.maxQuoteMicroUsd) throw new Error(`${t.name} price changed to ${tool.price.text}`);
      await this.client.data.getTool(tool.id);
      return tool.id;
    })());
    return this.ids.get(t.name)!;
  }

  async run(t: Expect, input: { query?: Record<string, unknown>; body?: Record<string, unknown> }): Promise<unknown | null> {
    const what = `${t.name} (${String(Object.values(input.query ?? input.body ?? {})[0] ?? "").slice(0, 60)})`;
    if (this.spent + this.reserved + t.worstCaseMicroUsd > this.cap) { this.notes.push(`Skipped ${t.name}: run cap ${this.cap} micro-USD reached.`); return null; }
    this.reserved += t.worstCaseMicroUsd;
    try {
      const tool_id = await this.toolId(t);
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await this.client.data.run({ tool_id, ...input });
        this.spent += out.cost_micro_usd ?? 0;
        if (out.status === "succeeded") return await unwrap(out.data);
        // Only an unbilled provider failure is safe to retry; anything billed is kept as-is.
        if ((out.cost_micro_usd ?? 0) > 0 || attempt === 1) { this.notes.push(`${what} failed: ${String(out.error ?? "unknown").slice(0, 160)}`); return null; }
      }
      return null;
    } catch (error) {
      // A lost response may still have been billed upstream; never retry it.
      this.notes.push(`${what} errored without a receipt (${error instanceof Error ? error.message.slice(0, 120) : "unknown"}); not retried.`);
      return null;
    } finally { this.reserved -= t.worstCaseMicroUsd; }
  }
}

// Large results arrive as a short-lived signed link to the JSON instead of inline data.
export async function unwrap(data: unknown, fetcher: typeof fetch = fetch): Promise<unknown> {
  const d = data as { data?: { download_link?: string; content_type?: string } } | null;
  const link = d?.data?.download_link;
  if (!link || !Object.keys(d!).every(k => k === "data")) return data;
  if (!link.startsWith("https://") || !/json/.test(d!.data!.content_type ?? "")) throw new Error("Unexpected download link in provider result.");
  const response = await fetcher(link, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Result download failed (HTTP ${response.status}).`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new Error("Result download exceeds 20 MB.");
  return JSON.parse(text);
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>) {
  const out: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

// ---------- consumer (B2C) and agent (B2A) classifiers ----------

const CONSUMER_ASK = /is there (an?|any) (app|website|site|tool|service)|wish (there was|there were|someone (made|would make)) an? (app|website|tool)|looking for an? (app|website|tool)|any apps? (that|for|to)|app recommendation/i;
// Sensitive or personal categories are excluded: we look for product gaps, not people's private lives.
const NOT_CONSUMER = /app developer|developer for|for hire|freelanc|hiring|\[hiring\]/i;
const SENSITIVE = /\b(dating|hookup|grindr|nsfw|sex|porn|nude|onlyfans|blowjob|e-?fuck|abuse|assault|suicid|self[- ]harm|therapy|diagnos|medication|immigra|gambl|wager|betting)/i;
export const CONSUMER_TOPICS: Record<string, { re: RegExp; text: string }> = {
  food: { re: /recipe|meal|ingredient|pantry|grocer|cook|diet|calorie|nutrition/i, text: "meal planning, recipes and groceries" },
  money: { re: /budget|expense|spending|savings?|bills?|subscription(s)? track|debt|invest/i, text: "budgeting and money tracking" },
  fitness: { re: /workout|gym|fitness|running|exercise|step|yoga/i, text: "workouts and fitness" },
  habits: { re: /habit|track(ing)? (my )?(hobbies|habits|progress)|journal|routine|streak/i, text: "habits, routines and journaling" },
  productivity: { re: /to-?do|task|reminder|calendar|schedul|notes?\b|focus|procrastinat|organi[sz]e/i, text: "tasks, reminders and organization" },
  social: { re: /mak(e|ing) (new )?friends|meet(ing)? (new )?(people|friends)|friendship|group activities/i, text: "making friends and meeting people" },
  learning: { re: /learn(ing)? (a )?language|study|flashcard|course|tutor|practice (speaking|reading)/i, text: "learning and studying" },
  home: { re: /chore|clean(ing)?|home (repair|maintenance)|plant|garden|inventory|declutter/i, text: "home, chores and plants" },
  travel: { re: /travel|trip|itinerar|flight|packing/i, text: "travel planning" },
  family: { re: /\bkids?\b|parent|baby|family|chores for kids/i, text: "family and parenting logistics" },
  shopping: { re: /price (track|drop|alert)|deal|coupon|compare prices|wishlist/i, text: "deals and price tracking" },
  media: { re: /book(s)? (track|recommend)|movie|tv show|music|podcast|watchlist/i, text: "tracking books, shows and music" },
};
export function consumerTopic(title: string, body: string, nsfw = false) {
  const text = `${title}\n${body.slice(0, 1200)}`.replace(/[\u2018\u2019]/g, "'");
  if (nsfw || SENSITIVE.test(text) || NOT_CONSUMER.test(text) || !CONSUMER_ASK.test(text)) return null;
  return Object.entries(CONSUMER_TOPICS).find(([, t]) => t.re.test(text))?.[0] ?? null;
}

const WISH = /\b(wish( it| they| you)?|please (add|make|bring|let)|would (be|love) (great|nice|amazing|it if)|needs? (an?|to have)|missing|if only|bring back|feature request|why (can'?t|isn'?t|doesn'?t))\b/i;
export const FEATURES: Record<string, { re: RegExp; text: string }> = {
  sync: { re: /sync|backup|back up|cloud|across (devices|my)/i, text: "sync and backup across devices" },
  export: { re: /export|csv|import|pdf|print/i, text: "import/export of their data" },
  platforms: { re: /android|web (version|app)|desktop|mac app|ipad|apple watch|watch app/i, text: "versions on other platforms (web, desktop, watch)" },
  sharing: { re: /shar(e|ing) with|family (plan|sharing)|partner|household|collaborat/i, text: "sharing with family or a partner" },
  pricing: { re: /subscription|too expensive|paywall|one[- ]time (purchase|payment)|price|free version/i, text: "a cheaper or one-time-purchase option" },
  ads: { re: /\bads?\b|advert/i, text: "fewer ads" },
  widgets: { re: /widget|lock screen|home screen/i, text: "home-screen widgets" },
  customization: { re: /customi[sz]|categor(y|ies)|dark mode|theme|font|layout|order/i, text: "more customization (categories, themes, layout)" },
  reminders: { re: /notification|remind|alert/i, text: "better reminders and notifications" },
  offline: { re: /offline|without (internet|wifi|connection)/i, text: "offline use" },
};
export function featureWish(text: string) {
  return WISH.test(text) ? Object.entries(FEATURES).filter(([, f]) => f.re.test(text)).map(([k]) => k) : [];
}

// What kind of tool an agent (or its builder) is asking for.
export const AGENT_DOMAINS: Record<string, { re: RegExp; text: string }> = {
  email: { re: /e-?mail|inbox|gmail|outlook|imap|smtp|mailbox/i, text: "email and inboxes" },
  calendar: { re: /calendar|schedul|meeting|booking/i, text: "calendars and scheduling" },
  docs: { re: /\bpdf|docx?\b|document|spreadsheet|excel|sheets|notion|confluence|wiki|markdown/i, text: "documents and spreadsheets" },
  browser: { re: /browser|scrap|crawl|playwright|puppeteer|web page|fetch (a|the) (web|url)/i, text: "browsing and web scraping" },
  data: { re: /database|postgres|mysql|sql|bigquery|snowflake|supabase|mongo|vector/i, text: "databases and data warehouses" },
  commerce: { re: /shopify|stripe|payment|invoice|checkout|e-?commerce|order/i, text: "payments and commerce" },
  crm: { re: /\bcrm\b|hubspot|salesforce|pipedrive|lead|sales/i, text: "CRM and sales tools" },
  devtools: { re: /github|gitlab|jira|linear|ci\b|sentry|kubernetes|k8s|terraform|logs?|observab|monitor/i, text: "developer and ops tools" },
  media: { re: /image|video|audio|animation|figma|design|transcri|speech|voice/i, text: "media, design and voice" },
  messaging: { re: /slack|discord|telegram|whatsapp|sms|teams|chat/i, text: "messaging platforms" },
  search: { re: /search|knowledge|rag\b|retriev|memory/i, text: "search, retrieval and memory" },
  finance: { re: /accounting|quickbooks|xero|bank|finance|tax/i, text: "accounting and finance" },
};
const AGENT_ASK = /\b(support|add|feature|request|integrat|official|provide|expose|server for|is there|looking for|need|wish|want)\b/i;
const AGENT_BUG = /\b(bug|error|crash|fail(s|ed|ing)?|broken|regression|never|rejected|doesn'?t work|not working|release)\b/i;
export function agentDomain(title: string, body?: string | null) {
  if (!title || !AGENT_ASK.test(title) || AGENT_BUG.test(title)) return null;
  return Object.entries(AGENT_DOMAINS).find(([, d]) => d.re.test(`${title}\n${(body ?? "").slice(0, 600)}`))?.[0] ?? null;
}

// ---------- revenue paths ----------

const biz = (offer: string, price_usd: number, model: Revenue["model"] = "one_time"): Revenue =>
  ({ payer: "the business", offer, model, price_usd, channel: "contact_form, then email", channel_ready: true });
const TASK_OFFER: Record<string, [string, number]> = {
  social_media: ["agent-run social media posts each week instead of a part-time hire", 199], bookkeeping: ["monthly agent-run bookkeeping cleanup and invoicing", 249],
  website: ["rebuilt website, live on our link before they pay", 99], writing: ["weekly newsletter and blog copy", 149],
  admin: ["inbox triage, data entry and scheduling done by agents", 149], reviews: ["drafted replies to every new review", 99], marketing: ["monthly SEO and local-listing fixes", 199],
};
// Agents pay per call when the tool is listed in a paid agent catalog (Monid provider listing, Naïve data
// catalog or an x402 endpoint); the project's maintainers can also pay for the integration itself.
const agentTool = (what: string): Revenue => ({ payer: "AI agents per call (and the project maintainers for the integration)",
  offer: `hosted MCP server/API for ${what}, listed in paid agent tool catalogs`, model: "per_call", price_usd: 0.002,
  channel: "agent tool catalog listing + GitHub issue reply", channel_ready: false,
  note: "Listing as a paid provider (Monid/x402) is not verified yet; a one-time $299 integration build for the maintainer is the fallback." });

export function revenueFor(pipeline: Pipeline, kind: string): Revenue {
  switch (pipeline) {
    case "maps": return kind === "no_hours" ? biz("fixed Google listing and an hours/menu page", 49) : biz("rebuilt one-page website, live on our link before they pay", 99);
    case "reviews": return ({ phone: biz("online booking and quote-request page with instant email replies", 149), booking: biz("working online booking page", 149),
      hours: biz("accurate hours/menu page and listing fix", 49), website: biz("rebuilt website", 99), ordering: biz("direct online-ordering page", 149),
      communication: biz("quote form with automatic follow-up emails", 99), pricing: biz("clear price list page and instant quote form", 99) } as Record<string, Revenue>)[kind] ?? biz("website fix", 99);
    case "appstore": return ({ english_only: biz("App Store listing translated into 6 languages", 49), stale_listing: biz("refreshed App Store listing copy and keywords", 79),
      low_rating: biz("drafted replies to recent negative reviews and a top-3 fixes report", 79) } as Record<string, Revenue>)[kind] ?? biz("App Store listing refresh", 79);
    case "jobs": { const [offer, price] = TASK_OFFER[kind] ?? ["the advertised work, done by agents", 149]; return biz(offer, price, kind === "website" ? "one_time" : "monthly"); }
    case "reddit": { const [offer, price] = TASK_OFFER[kind] ?? ["the requested work, done by agents", 149];
      return { ...biz(offer, price, kind === "website" ? "one_time" : "monthly"), channel: "reply in the thread with a free sample link", channel_ready: false }; }
    case "consumer_posts": return { payer: "consumers", offer: `small web app for ${CONSUMER_TOPICS[kind]?.text ?? kind}, free tier then paid`, model: "monthly", price_usd: 4,
      channel: "X reply with the app link (Reddit thread reply for Reddit leads)", channel_ready: false, note: "Paid through a Stripe Payment Link on the app." };
    case "app_wishes": return { payer: "the app's developer", offer: `user-evidence brief and working prototype of ${FEATURES[kind]?.text ?? kind}`, model: "one_time", price_usd: 149,
      channel: "contact_form, then email (developer's site)", channel_ready: true, note: "Alternative: a companion web tool consumers pay for." };
    case "agent_github": case "agent_forums": return agentTool(AGENT_DOMAINS[kind]?.text ?? kind);
  }
}
const CHANNEL_OF = (lead: Lead, r: Revenue) => lead.external_id.startsWith("x:") ? "x_reply" : lead.external_id.startsWith("reddit:") ? "reddit_reply"
  : lead.external_id.startsWith("hn:") ? "hn_reply" : lead.external_id.startsWith("github:") ? "github_issue_reply" : r.channel_ready ? "contact_form" : r.channel;

// ---------- the business (B2B) pipelines ----------

type MapsListing = { title: string; place_id: string; website?: string; operating_hours?: unknown; reviews?: number; type?: string; address?: string; rating?: number; category: string };

async function mapsListings(s: Sources, scope: Scope) {
  const pages = await pool(scope.categories, 4, async category => {
    const data = await s.run(TOOLS.maps, { query: { q: category, type: "search", location: scope.area, z: 14, hl: "en", gl: "us" } }) as { local_results?: MapsListing[] } | null;
    return (data?.local_results ?? []).filter(l => l.place_id && l.title).map(l => ({ ...l, category }));
  });
  return pages.flat();
}

function mapsIdeas(listings: MapsListing[], scope: Scope, at: string, notes: string[]): Idea[] {
  notes.push(`maps: ${listings.length} listings across ${scope.categories.length} categories.`);
  const rows = listings.flatMap(l => mapsGaps(l).map(gap => ({ l, gap })));
  return group(rows, r => `${r.l.category}|${r.gap}`, r => r.l.place_id).map(([key, rs]) => {
    const [category, gap] = key.split("|");
    const leads = rs.map(({ l }): Lead => ({ name: l.title, url: cleanUrl(l.website), contact_url: null, email: null, external_id: l.place_id,
      data: { evidence: [{ url: `https://www.google.com/maps/place/?q=place_id:${l.place_id}`, observation: `Google Maps listing (${l.type ?? category}, ${l.reviews ?? 0} reviews): ${GAP_TEXT[gap]}.` }],
        issues: [gap], observed_at: at, discovery_query: `${category} in ${scope.area}`, signal_type: "inferred_gap", contact_verified: false } }));
    return { pipeline: "maps" as const, kind: gap, rank: GAP_RANK[gap] ?? 0, cluster: { label: `${scope.area}: ${category} businesses that ${GAP_TEXT[gap]}`, source: "google_maps", unserved_score: score("inferred_gap", leads.length) }, leads,
      why: `${leads.length} ${category} listings ${GAP_TEXT[gap]}.` };
  });
}

type Review = { biz: { name: string; id: string; url: string | null; category: string; reviewUrl: string }; text: string; date?: string; source: string };

async function yelpReviews(s: Sources, scope: Scope): Promise<Review[] | null> {
  const first = await s.run(TOOLS.yelpSearch, { query: { find_loc: scope.area, find_desc: scope.categories[0] } }) as { organic_results?: unknown[] } | null;
  if (!first?.organic_results) return null; // Yelp unavailable; caller falls back to Google reviews.
  const rest = await pool(scope.categories.slice(1, 3), 2, c => s.run(TOOLS.yelpSearch, { query: { find_loc: scope.area, find_desc: c } }) as Promise<{ organic_results?: unknown[] } | null>);
  const bizs = [first, ...rest].flatMap((page, i) => (page?.organic_results ?? []).slice(0, 4).map(b => ({ b: b as { name?: string; title?: string; place_ids?: string[]; place_id?: string; link?: string; website?: string }, category: scope.categories[i] })));
  const out = await pool(bizs, 4, async ({ b, category }) => {
    const id = b.place_id ?? b.place_ids?.[0];
    if (!id) return [];
    const data = await s.run(TOOLS.yelpReviews, { query: { place_id: id, sortby: "rating_asc", num: 20 } }) as { reviews?: { comment?: { text?: string }; text?: string; date?: string }[] } | null;
    return (data?.reviews ?? []).map(r => ({ biz: { name: b.name ?? b.title ?? id, id: `yelp:${id}`, url: cleanUrl(b.website), category, reviewUrl: b.link ?? `https://www.yelp.com/biz/${id}` }, text: r.comment?.text ?? r.text ?? "", date: r.date, source: "yelp_reviews" }));
  });
  return out.flat();
}

async function googleReviews(s: Sources, listings: MapsListing[]): Promise<Review[]> {
  // Reuse Maps place IDs (no extra search); prefer businesses with enough reviews to show a pattern.
  // At most 3 per category (18 calls, 2,700 micro-USD).
  const picks = [...new Map(listings.filter(l => (l.reviews ?? 0) >= 15).map(l => [l.place_id, l])).values()]
    .sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0));
  const perCategory = new Map<string, number>();
  const chosen = picks.filter(l => { const n = perCategory.get(l.category) ?? 0; perCategory.set(l.category, n + 1); return n < 3; });
  const out = await pool(chosen, 6, async l => {
    const data = await s.run(TOOLS.googleReviews, { query: { place_id: l.place_id, sort_by: "ratingLow", num: 30, hl: "en", gl: "us" } }) as { reviews?: { snippet?: string; iso_date?: string; link?: string }[] } | null;
    return (data?.reviews ?? []).map(r => ({ biz: { name: l.title, id: l.place_id, url: cleanUrl(l.website), category: l.category, reviewUrl: r.link ?? `https://www.google.com/maps/place/?q=place_id:${l.place_id}` }, text: r.snippet ?? "", date: r.iso_date, source: "google_reviews" }));
  });
  return out.flat();
}

function reviewIdeas(reviews: Review[], scope: Scope, at: string, notes: string[]): Idea[] {
  notes.push(`reviews: ${new Set(reviews.map(r => r.biz.id)).size} businesses, ${reviews.length} reviews scanned.`);
  // An idea needs the same complaint at 3+ different businesses; one business alone is an anecdote.
  const perBiz = new Map<string, { r: Review; pains: Map<string, Review[]> }>();
  for (const r of reviews) {
    const entry = perBiz.get(r.biz.id) ?? { r, pains: new Map() };
    for (const p of reviewPains(r.text)) entry.pains.set(p, [...(entry.pains.get(p) ?? []), r]);
    perBiz.set(r.biz.id, entry);
  }
  const rows = [...perBiz.values()].flatMap(({ r, pains }) => [...pains].map(([pain, rs]) => ({ biz: r.biz, pain, rs })));
  // Group across categories by pain: the buyer problem, not the business type, defines the idea.
  return group(rows, x => x.pain, x => x.biz.id, 3).map(([pain, xs]) => {
    const leads = xs.map(({ biz, rs }): Lead => ({ name: biz.name, url: biz.url, contact_url: null, email: null, external_id: biz.id,
      data: { evidence: rs.slice(0, 3).map(r => ({ url: biz.reviewUrl, observation: `${r.date ? r.date.slice(0, 10) + " " : ""}review: "${r.text.replace(/\s+/g, " ").slice(0, 280)}"` })),
        issues: [pain], observed_at: at, discovery_query: `${biz.category} reviews in ${scope.area}`, signal_type: "repeated_pain", contact_verified: false } }));
    const categories = [...new Set(xs.map(x => x.biz.category))].join(", ");
    return { pipeline: "reviews" as const, kind: pain, rank: xs.reduce((n, x) => n + x.rs.length, 0), cluster: { label: `${scope.area} local businesses where ${PAINS[pain].text}`, source: xs[0].rs[0].source, unserved_score: score("repeated_pain", leads.length) }, leads,
      why: `${leads.length} businesses (${categories}) have reviews where ${PAINS[pain].text}.` };
  });
}

type App = { id: number; title: string; link: string; developer: { name: string; link: string }; seller_link?: string; supported_languages?: string[]; rating?: { count: number; rating: number }[]; latest_version_release_date?: string; term: string };
export async function appIdeas(s: Sources, scope: Scope, at: string, now: Date): Promise<Idea[]> {
  const pages = await pool(scope.appTerms, 6, async term => {
    const data = await s.run(TOOLS.appstore, { query: { term, num: 50, country: "us" } }) as { organic_results?: App[] } | null;
    return (data?.organic_results ?? []).map(a => ({ ...a, term }));
  });
  const rows = pages.flat().flatMap(a => appSignals(a, now).map(sig => ({ a, sig })));
  s.notes.push(`appstore: ${pages.flat().length} apps from ${scope.appTerms.length} searches, ${rows.length} signals.`);
  // Group by signal across terms; one developer counts once per idea.
  return group(rows, r => r.sig, r => String(r.a.developer?.name ?? r.a.id)).map(([sig, rs]) => {
    const leads = rs.map(({ a }): Lead => ({ name: `${a.developer?.name ?? "Unknown developer"} (${a.title})`, url: cleanUrl(a.seller_link) ?? a.link, contact_url: null, email: null, external_id: `appstore:${a.id}`,
      data: { evidence: [{ url: a.link, observation: `${a.title}: ${a.rating?.[0]?.count ?? 0} ratings, ${a.rating?.[0]?.rating ?? "n/a"} stars, languages ${JSON.stringify(a.supported_languages ?? [])}, last update ${a.latest_version_release_date ?? "unknown"}.` }],
        issues: [sig], observed_at: at, discovery_query: `App Store: ${a.term}`, signal_type: "inferred_gap", contact_verified: false } }));
    const terms = [...new Set(rs.map(r => r.a.term))].slice(0, 4).join(", ");
    return { pipeline: "appstore" as const, kind: sig, rank: 0, cluster: { label: `Indie app developers (${terms}) that ${APP_TEXT[sig]}`, source: "app_store", unserved_score: score("inferred_gap", leads.length) }, leads,
      why: `${leads.length} small developers ${APP_TEXT[sig]}.` };
  });
}

type Job = { job_id: string; title: string; employer_name: string; source_url?: string; source_name?: string; salary?: string; contract_type?: string; timestamp?: string; keyword: string };
async function jobIdeas(s: Sources, scope: Scope, at: string): Promise<Idea[]> {
  const city = scope.area.split(",").slice(-2).map(x => x.trim());
  const location = city.length === 2 && city[1] === "CA" ? `${city[0]},California,United States` : "United States";
  const pages = await pool(scope.jobKeywords, 5, async keyword => {
    const data = await s.run(TOOLS.jobs, { body: { keyword, location_name: location, language_code: "en", depth: 10 } }) as { items?: Job[] }[] | null;
    return (data ?? []).flatMap(p => p.items ?? []).map(j => ({ ...j, keyword }));
  });
  const rows = pages.flat().filter(j => j.job_id && isSmallEmployer(j.employer_name ?? ""));
  s.notes.push(`jobs: ${pages.flat().length} postings, ${rows.length} from direct employers.`);
  return group(rows, j => taskOf(j.title), j => j.employer_name.toLowerCase()).map(([task, js]) => {
    const leads = js.map((j): Lead => ({ name: j.employer_name, url: null, contact_url: null, email: null, external_id: `job:${j.job_id}`,
      data: { evidence: [{ url: j.source_url ?? "https://www.google.com/search?udm=8", observation: `Hiring "${j.title}" (${j.contract_type ?? "type n/a"}${j.salary ? `, ${j.salary}` : ""}) ${j.source_name ?? ""}, posted ${j.timestamp?.slice(0, 10) ?? "recently"}.` }],
        issues: [task], observed_at: at, discovery_query: `Google Jobs: ${j.keyword}`, signal_type: "explicit_request", contact_verified: false } }));
    return { pipeline: "jobs" as const, kind: task, rank: 0, cluster: { label: `Employers near ${location.split(",")[0]} hiring paid help for ${TASKS[task].text}`, source: "google_jobs", unserved_score: score("explicit_request", leads.length) }, leads,
      why: `${leads.length} employers posted paid roles for ${TASKS[task].text}.` };
  });
}

type RedditPost = { id: string; postTitle: string; permalink: string; createdAt?: string; score?: number; commentCount?: number; content?: { markdown?: string }; subreddit?: { name?: string } };
async function redditIdeas(s: Sources, scope: Scope, at: string): Promise<Idea[]> {
  const pages = await pool(scope.redditQueries, 4, async q => {
    const data = await s.run(TOOLS.reddit, { query: { query: q, search_type: "post", sort: "NEW", time_range: "month", need_format: true, allow_nsfw: "0" } }) as { children?: { post?: RedditPost }[] } | null;
    return (data?.children ?? []).map(c => c.post).filter((p): p is RedditPost => !!p?.id && !!p.permalink).map(p => ({ ...p, q }));
  });
  const rows = pages.flat();
  s.notes.push(`reddit: ${rows.length} recent posts from ${scope.redditQueries.length} searches.`);
  // Owners asking for help are the demand signal; posts are evidence. Reddit gives no business contact route,
  // so these ideas need Scout/Creator to find buyers like the posters through another source.
  return group(rows, p => redditTask(p.postTitle, p.content?.markdown ?? ""), p => p.id).map(([task, ps]) => {
    const leads = ps.map((p): Lead => ({ name: `r/${p.subreddit?.name ?? "reddit"}: ${p.postTitle.slice(0, 120)}`, url: null, contact_url: null, email: null, external_id: `reddit:${p.id}`,
      data: { evidence: [{ url: `https://www.reddit.com${p.permalink}`, observation: `${p.createdAt?.slice(0, 10) ?? ""} post (${p.score ?? 0} points, ${p.commentCount ?? 0} comments): "${p.postTitle.slice(0, 200)}"` }],
        issues: [task], observed_at: at, discovery_query: p.q, signal_type: "explicit_request", contact_verified: false } }));
    return { pipeline: "reddit" as const, kind: task, rank: 0, cluster: { label: `Small business owners on Reddit asking for help with ${TASKS[task].text}`, source: "reddit", unserved_score: score("explicit_request", leads.length) }, leads,
      why: `${leads.length} owner posts in the last month ask for help with ${TASKS[task].text}.` };
  });
}

// ---------- the consumer (B2C) pipelines ----------

type AnyPost = { id: string; title: string; selftext?: string; permalink: string; subreddit?: string; score?: number; numComments?: number; createdUtc?: number; nsfw?: boolean };
type XPost = { id: string; text?: string; url?: string; lang?: string; isReply?: boolean; replyCount?: number; likeCount?: number; createdUtc?: number };
// One person cross-posting the same question to several places is one signal, not several.
export const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
const redditUrl = (p: AnyPost) => p.permalink.startsWith("http") ? p.permalink : `https://www.reddit.com${p.permalink}`;
const day = (utc?: number) => utc ? new Date(utc * 1000).toISOString().slice(0, 10) : "";

// A public post as a lead: the reachable place where demand was expressed. We store the post link and
// its text, never the poster's name, handle or profile.
type PostRow = { id: string; title: string; url: string; where: string; n: number; at?: number; query: string };
function postLead(r: PostRow, issue: string, at: string, signal: SignalType): Lead {
  return { name: `${r.where}: ${r.title.replace(/\s+/g, " ").slice(0, 120)}`, url: r.url, contact_url: r.url, email: null, external_id: r.id,
    data: { evidence: [{ url: r.url, observation: `${day(r.at)} ${r.where} (${r.n} replies): "${r.title.replace(/\s+/g, " ").slice(0, 240)}"` }],
      issues: [issue], observed_at: at, discovery_query: r.query, signal_type: signal, contact_verified: false } };
}

async function consumerPostIdeas(s: Sources, scope: Scope, at: string): Promise<Idea[]> {
  const [reddit, x] = await Promise.all([
    pool(scope.consumerQueries, 6, async q => ((await s.monid("reddit", { query: q, timeframe: "month" }) as { posts?: AnyPost[] } | null)?.posts ?? []).map(p => ({ p, q }))),
    pool(scope.consumerXQueries, 4, async q => ((await s.monid("x_search", { query: q }) as { items?: XPost[] } | null)?.items ?? []).map(p => ({ p, q }))),
  ]);
  const rows: (PostRow & { topic: string })[] = [];
  for (const { p, q } of reddit.flat()) {
    const topic = p.id && p.permalink ? consumerTopic(p.title, p.selftext ?? "", p.nsfw) : null;
    if (topic) rows.push({ id: `reddit:${p.id}`, title: p.title, url: redditUrl(p), where: `r/${p.subreddit ?? "?"}`, n: p.numComments ?? 0, at: p.createdUtc, query: q, topic });
  }
  for (const { p, q } of x.flat()) {
    if (!p.id || p.isReply || (p.lang && p.lang !== "en")) continue;
    const topic = consumerTopic(p.text ?? "", "");
    // Handle-free status URL, so no username is stored.
    if (topic) rows.push({ id: `x:${p.id}`, title: p.text ?? "", url: `https://x.com/i/web/status/${p.id}`, where: "X", n: p.replyCount ?? 0, at: p.createdUtc, query: q, topic });
  }
  s.notes.push(`consumer_posts: ${reddit.flat().length} Reddit + ${x.flat().length} X posts, ${rows.length} consumer asks.`);
  return group(rows, r => r.topic, r => titleKey(r.title), 2).map(([topic, rs]) => ({
    pipeline: "consumer_posts" as const, kind: topic!, rank: rs.reduce((n, r) => n + r.n, 0),
    cluster: { label: `Consumers asking for an app or service for ${CONSUMER_TOPICS[topic!].text}`, source: "reddit_x", unserved_score: score("explicit_request", rs.length) },
    leads: rs.map(r => postLead(r, topic!, at, "explicit_request")),
    why: `${rs.length} public posts in the last month ask for an app for ${CONSUMER_TOPICS[topic!].text}.` }));
}

type AppReview = { id?: string; rating?: number; title?: string; text?: string; review_date?: string };
async function appWishIdeas(s: Sources, scope: Scope, at: string): Promise<Idea[]> {
  // Popular consumer apps; their reviews show what many users want and the app does not ship yet.
  const found = await pool(scope.consumerAppTerms, 6, async term => {
    const data = await s.run(TOOLS.appstore, { query: { term, num: 10, country: "us" } }) as { organic_results?: App[] } | null;
    return (data?.organic_results ?? []).filter(a => (a.rating?.[0]?.count ?? 0) >= 1000).slice(0, 2).map(a => ({ ...a, term }));
  });
  const apps = found.flat();
  const reviews = await pool(apps, 6, async a => {
    const data = await s.run(TOOLS.appReviews, { query: { product_id: String(a.id), country: "us", sort: "mosthelpful" } }) as { reviews?: AppReview[] } | null;
    return (data?.reviews ?? []).map(r => ({ a, r }));
  });
  const rows = reviews.flat().flatMap(({ a, r }) => featureWish(`${r.title ?? ""}. ${r.text ?? ""}`).map(f => ({ a, r, f })));
  s.notes.push(`app_wishes: ${apps.length} popular apps, ${reviews.flat().length} reviews, ${rows.length} feature wishes.`);
  // A wish counts when 3+ reviews across 2+ different apps ask for it. The developers are the leads:
  // they are reachable and can pay for the feature their users keep asking for.
  const byFeature = new Map<string, typeof rows>();
  for (const row of rows) byFeature.set(row.f, [...(byFeature.get(row.f) ?? []), row]);
  return [...byFeature].filter(([, rs]) => rs.length >= 3 && new Set(rs.map(r => r.a.id)).size >= 2).map(([f, rs]) => {
    const terms = [...new Set(rs.map(r => r.a.term))].slice(0, 4).join(", ");
    const byApp = new Map<number, typeof rs>();
    for (const r of rs) byApp.set(r.a.id, [...(byApp.get(r.a.id) ?? []), r]);
    const leads = [...byApp.values()].map((ars): Lead => {
      const a = ars[0].a;
      return { name: `${a.developer?.name ?? "Unknown developer"} (${a.title})`, url: cleanUrl(a.seller_link) ?? a.link, contact_url: null, email: null, external_id: `appstore:${a.id}`,
        data: { evidence: ars.slice(0, 3).map(({ r }) => ({ url: a.link, observation: `Review (${r.rating ?? "?"}★, ${r.review_date ?? ""}): "${`${r.title ?? ""}. ${r.text ?? ""}`.replace(/\s+/g, " ").slice(0, 240)}"` })),
          issues: [f], observed_at: at, discovery_query: `App Store reviews: ${a.term}`, signal_type: "repeated_pain", contact_verified: false } };
    });
    return { pipeline: "app_wishes" as const, kind: f, rank: rs.length,
      cluster: { label: `Users of ${terms} apps asking for ${FEATURES[f].text}`, source: "app_store_reviews", unserved_score: score("repeated_pain", leads.length) }, leads,
      why: `${rs.length} reviews across ${leads.length} popular ${terms} apps ask for ${FEATURES[f].text}.` };
  });
}

// ---------- the agent (B2A) pipelines ----------

type Issue = { id: string | number; title: string; body?: string; url: string; repo: string; comments?: number; reactions?: number | { total_count?: number }; createdUtc?: number; isPullRequest?: boolean };
async function agentGithubIdeas(s: Sources, scope: Scope, now: Date, at: string): Promise<Idea[]> {
  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  const pages = await pool(scope.agentIssueQueries, 3, async q => {
    const query = `${q} created:>${since}`;
    return ((await s.monid("github_issues", { query, limit: 100, sort: "reactions" }) as { issues?: Issue[] } | null)?.issues ?? []).map(i => ({ i, query }));
  });
  const issues = [...new Map(pages.flat().filter(({ i }) => !i.isPullRequest && i.url && i.repo).map(x => [String(x.i.id), x])).values()];
  const rows = issues.map(x => ({ ...x, d: agentDomain(x.i.title, x.i.body) })).filter(r => r.d);
  s.notes.push(`agent_github: ${issues.length} open issues since ${since}, ${rows.length} agent-integration requests.`);
  const reactions = (i: Issue) => typeof i.reactions === "number" ? i.reactions : i.reactions?.total_count ?? 0;
  // The projects are the leads: their users want agent access, and they (or the agents) can pay for it.
  return group(rows, r => r.d, r => r.i.repo, 3).map(([d, rs]) => ({
    pipeline: "agent_github" as const, kind: d!, rank: rs.reduce((n, r) => n + reactions(r.i) + (r.i.comments ?? 0), 0),
    cluster: { label: `Agents need MCP/API access to ${AGENT_DOMAINS[d!].text}: open requests in ${rs.length} GitHub projects`, source: "github_issues", unserved_score: score("explicit_request", rs.length) },
    leads: rs.map(({ i, query }): Lead => ({ name: i.repo, url: `https://github.com/${i.repo}`, contact_url: i.url, email: null, external_id: `github:${i.repo}`,
      data: { evidence: [{ url: i.url, observation: `Open issue "${i.title.slice(0, 200)}" (${reactions(i)} reactions, ${i.comments ?? 0} comments)` }],
        issues: [d!], observed_at: at, discovery_query: query, signal_type: "explicit_request", contact_verified: false } })),
    why: `${rs.length} projects have open requests for agent/MCP access to ${AGENT_DOMAINS[d!].text}.` }));
}

const FORUM_NOISE = /\b(course|job|career|advice|feedback|hiring|i built|i made|my (open[- ]source )?(project|framework)|study|learn)\b/i;
const TOOL_ASK = /\b(is there|looking for|need|recommend|any (good )?(tool|mcp|server|api)|wish|want)\b/i;
type HnStory = { id: string; title: string; permalink: string; points?: number; comments?: number; createdUtc?: number };
async function agentForumIdeas(s: Sources, scope: Scope, now: Date, at: string): Promise<Idea[]> {
  const [reddit, hn] = await Promise.all([
    pool(scope.agentForumQueries, 5, async q => ((await s.monid("reddit", { query: q, timeframe: "month" }) as { posts?: AnyPost[] } | null)?.posts ?? []).map(p => ({ p, q }))),
    pool(scope.agentHnQueries, 3, async q => ((await s.monid("hackernews", { query: q, tags: "story" }) as { results?: HnStory[] } | null)?.results ?? []).map(h => ({ h, q }))),
  ]);
  const yearAgo = now.getTime() / 1000 - 365 * 86_400;
  const items: PostRow[] = [
    ...reddit.flat().map(({ p, q }) => ({ id: `reddit:${p.id}`, title: p.title, url: redditUrl(p), where: `r/${p.subreddit}`, n: p.numComments ?? 0, at: p.createdUtc, query: q })),
    ...hn.flat().filter(({ h }) => (h.createdUtc ?? 0) > yearAgo).map(({ h, q }) => ({ id: `hn:${h.id}`, title: h.title, url: h.permalink, where: "Hacker News", n: h.comments ?? 0, at: h.createdUtc, query: q })),
  ];
  const unique = [...new Map(items.map(i => [i.id, i])).values()];
  // Forum posts are chattier than issues: the tool ask and its domain must both be in the title.
  const rows = unique.map(i => ({ i, d: agentDomain(i.title.replace(/[\u2018\u2019]/g, "'")) }))
    .filter(r => r.d && !SELLER.test(r.i.title) && !FORUM_NOISE.test(r.i.title) && TOOL_ASK.test(r.i.title));
  s.notes.push(`agent_forums: ${unique.length} posts (Reddit + HN), ${rows.length} agent-tool asks.`);
  return group(rows, r => r.d, r => titleKey(r.i.title), 2).map(([d, rs]) => ({
    pipeline: "agent_forums" as const, kind: d!, rank: rs.reduce((n, r) => n + r.i.n, 0),
    cluster: { label: `Agent builders asking for a tool for ${AGENT_DOMAINS[d!].text}`, source: "reddit_hn", unserved_score: score("explicit_request", rs.length) },
    leads: rs.map(r => postLead(r.i, d!, at, "explicit_request")),
    why: `${rs.length} agent-builder posts ask for tools for ${AGENT_DOMAINS[d!].text}.` }));
}

// ---------- orchestration ----------

export async function scoutIdeas(client: Pick<VettaClient, "data">, requestId: string, scope: Scope = DEFAULT_SCOPE,
  options: { directory?: string; now?: () => Date; monid?: MonidReader | null } = {}): Promise<{ path: string; run: IdeasRun }> {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Request ID must be 8..100 letters, digits, underscores or hyphens.");
  const directory = options.directory ?? resolve("var/scout/ideas");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${requestId}.json`);
  try { return { path, run: JSON.parse(await readFile(path, "utf8")) as IdeasRun }; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const now = options.now ?? (() => new Date());
  const started = now();
  try { await writeFile(join(directory, `${requestId}.started`), JSON.stringify({ scope, at: started.toISOString() }), { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("This ideas pass already started without a saved result. Inspect provider usage before starting another paid pass with a new request ID."); }

  let monid = options.monid;
  if (monid === undefined) { try { monid = monidClient(); } catch { monid = null; } }
  const s = new Sources(client, RUN_CAP_MICRO_USD, monid);
  const at = started.toISOString();
  const safe = async (p: Pipeline, f: () => Promise<Idea[]>) => {
    const t0 = Date.now();
    try { return await f(); } catch (e) { s.notes.push(`${p} pipeline stopped: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}`); return []; }
    finally { s.notes.push(`${p} took ${Math.round((Date.now() - t0) / 1000)} s.`); }
  };
  const listingsP = mapsListings(s, scope);
  const [maps, reviews, appstore, jobs, reddit, consumer_posts, app_wishes, agent_github, agent_forums] = await Promise.all([
    safe("maps", async () => mapsIdeas(await listingsP, scope, at, s.notes)),
    safe("reviews", async () => {
      const yelp = await yelpReviews(s, scope);
      if (yelp?.length) return reviewIdeas(yelp, scope, at, s.notes);
      s.notes.push("Yelp search unavailable this pass; used Google reviews for the same Maps businesses.");
      return reviewIdeas(await googleReviews(s, await listingsP), scope, at, s.notes);
    }),
    safe("appstore", () => appIdeas(s, scope, at, started)),
    safe("jobs", () => jobIdeas(s, scope, at)),
    safe("reddit", () => redditIdeas(s, scope, at)),
    safe("consumer_posts", () => consumerPostIdeas(s, scope, at)),
    safe("app_wishes", () => appWishIdeas(s, scope, at)),
    safe("agent_github", () => agentGithubIdeas(s, scope, started, at)),
    safe("agent_forums", () => agentForumIdeas(s, scope, started, at)),
  ]);
  const picked = pickIdeas({ maps, reviews, appstore, jobs, reddit, consumer_posts, app_wishes, agent_github, agent_forums });
  // Every idea leaves with a buyer type, a revenue path and leads carrying both (in lead data, which
  // foundry.add_leads stores as-is), so the contract is filled without a schema change.
  const ideas = Object.values(picked).flat().map(i => {
    const buyer = BUYER[i.pipeline], revenue = revenueFor(i.pipeline, i.kind);
    return { ...i, buyer, revenue, leads: i.leads.map(l => ({ ...l, data: { ...l.data, buyer_type: buyer, revenue, channel: CHANNEL_OF(l, revenue) } })) };
  }).filter(i => i.leads.length);
  const per_pipeline = Object.fromEntries(Object.entries(picked).map(([p, i]) => [p, i.length])) as Record<Pipeline, number>;
  for (const [p, n] of Object.entries(per_pipeline)) if (n < PER_PIPELINE.min) s.notes.push(`${p} produced ${n} idea(s), below the target of ${PER_PIPELINE.min}.`);
  if (ideas.length < 15) s.notes.push(`Only ${ideas.length} ideas met the evidence thresholds (target 15-20). Widen the scope rather than lowering thresholds.`);
  const run: IdeasRun = { request_id: requestId, area: scope.area, started_at: at, finished_at: now().toISOString(), spent_micro_usd: s.spent, ideas, per_pipeline, notes: s.notes };
  await writeFile(path, JSON.stringify(run, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { path, run };
}

// Compact, bounded context for a Scout session that verifies chosen ideas and writes them to Foundry.
// picks are 1-based positions in run.ideas, as printed by `pnpm scout ideas`.
export function ideasContext(run: IdeasRun, picks: number[]) {
  if (!picks.length || picks.length > MAX_HANDOFF || picks.some(n => !Number.isInteger(n) || n < 1 || n > run.ideas.length) || new Set(picks).size !== picks.length) {
    throw new Error(`Pick 1..${MAX_HANDOFF} distinct ideas by number (1..${run.ideas.length}).`);
  }
  const ideas = picks.map(n => run.ideas[n - 1]).map(i => ({
    buyer: i.buyer, pipeline: i.pipeline, label: i.cluster.label, source: i.cluster.source, score: i.cluster.unserved_score, why: i.why, revenue: i.revenue,
    leads: i.leads.slice(0, 10).map(l => ({ name: l.name, url: l.url, contact_url: l.contact_url, external_id: l.external_id, channel: l.data.channel,
      evidence: l.data.evidence.slice(0, 2), issues: l.data.issues, discovery_query: l.data.discovery_query })) }));
  const context = JSON.stringify({ request_id: run.request_id, observed_at: run.started_at, ideas });
  if (context.length > 40_000) throw new Error("Chosen ideas exceed the 40,000-character context bound; pick fewer.");
  return context;
}
export const MAX_HANDOFF = 5;
