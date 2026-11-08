# Scout ideas: nine pipelines, three buyer types, up to 20 ideas per pass

`pnpm scout ideas` runs nine source pipelines in parallel. Each pipeline proposes 2–5 ideas, with at most 20 in total, for one of three buyer types: **businesses (B2B)**, **consumers (B2C)** and **AI agents and their builders (B2A)**. See the contract's [buyer types](foundry-contract.md#buyer-types).

An idea is a cluster (the buyer's problem), its leads in the `foundry.add_leads` shape, and a **revenue path**: who pays, for what, how much, and through which channel. Every lead carries `buyer_type`, `channel` and `revenue` in its `data`, so all three buyer types fill the contract without a schema change. This step uses no LLM: fixed rules filter the provider data.

```sh
pnpm scout ideas                                   # default area: Mission District, San Francisco, CA
pnpm scout ideas --area "Temescal, Oakland, CA" --request-id YOUR_UNIQUE_ID
# Hand up to 5 chosen ideas (numbers as printed, 1-based) to a Scout session that verifies and saves them:
pnpm scout run --ideas var/scout/ideas/YOUR_UNIQUE_ID.json --pick 7,13,19
```

| Buyer | Pipeline | Source | Signal |
|---|---|---|---|
| business | maps | Naïve `Search Google Maps`, 6 categories (150 µ$/call) | No website, a social or free-builder site, an `http://` link, no hours |
| business | reviews | Naïve `Search Yelp` → `Get Yelp Reviews`; falls back to `Get Google Reviews` (150 µ$/call) | The same complaint at 3+ businesses: unanswered calls or emails, surprise pricing, wrong hours, broken booking or website |
| business | appstore | Naïve `Search App Store` (150 µ$/call) | Apps with 20–50k ratings that are English-only, have a listing older than a year, or rate under 3.5★ |
| business | jobs | Naïve `Google Jobs Results` (billed 2,400 µ$/call) | Direct employers paying for work an agent can do |
| business | reddit | Naïve Reddit app search, 8 owner-forum queries (1,000 µ$/call) | First-person owner asks, with sellers and ads removed |
| consumer | consumer_posts | **Monid** `anyapi /reddit.search` (350 µ$/call) + `anyapi /twitter.search` (540 µ$/call) | "Is there an app…", grouped by topic. Dating, health, NSFW, gambling and hiring posts are excluded |
| consumer | app_wishes | Naïve `Search App Store` + `Get App Store Reviews` (150 µ$/call) | The same feature wish in 3+ reviews across 2+ popular apps |
| agent | agent_github | **Monid** `anyapi /github.search_issues` (2,400 µ$/call) | Open issues from the last 60 days requesting MCP/agent access, grouped by tool domain, in 3+ projects |
| agent | agent_forums | **Monid** Reddit (r/mcp, r/AI_Agents, r/ClaudeAI, r/n8n, r/LocalLLaMA) + `anyapi /hackernews.search` (1,500 µ$/call) | Tool asks in the title. Courses, job posts, "I built…" and sellers are removed |

## Leads and revenue by buyer type

| Buyer | Leads | Who pays | Channel today |
|---|---|---|---|
| business | Businesses (Scout verifies an inquiry form or business email) | The business: $49–$149 one-time, or $149–$249/month for agent-run work that replaces a hire | `contact_form` → `email` ✅ |
| consumer (posts) | The public posts asking (Reddit thread or handle-free X status URL), never the person | Consumers: about $4/month for a small web app, through a Stripe Payment Link | `x_reply` / `reddit_reply` ❌ not ready |
| consumer (app wishes) | The apps' developers | The developer: $149 for a user-evidence brief and working prototype of the wished-for feature | `contact_form` → `email` ✅ |
| agent | GitHub projects with open MCP/agent-access requests (issue URL as contact route), or agent-builder posts | **Agents per call** (about $0.002) for a hosted tool listed in a paid agent catalog (Monid provider, Naïve data catalog, x402); the maintainer pays for the integration as a fallback | catalog listing / `github_issue_reply` ❌ not verified |

Revenue figures are Scout's hypotheses for Creator, who writes the final offer. Cross-posts of the same question count once.

## How Monid helps

Monid reaches sources Naïve's catalog doesn't list (GitHub issues, Hacker News), plus Reddit at about a third of Naïve's price. `scripts/monid-client.ts` exposes only a **fixed allowlist** of read endpoints (`READ_SOURCES`), each pinned to a route and a maximum per-call price. Every call re-inspects the price first, and a billed run is never retried. Without `MONID_API_KEY`, the three Monid pipelines are skipped with a note.

Other Monid sources worth adding next, all checked in its catalog on November 7:
- G2 reviews ($0.00005/call), for B2B software gaps.
- Trustpilot reviews ($0.00066), for consumer complaints about companies.
- Google Play reviews ($0.00013).
- Google Trends ($0.002), to check whether an idea is growing.
- Screenshots ($0.0005–$0.0013), to verify website gaps.

## Verified on November 7

Pass `ideas-live-9` (after adding leads and revenue): **20 ideas, 152 leads, every lead with a revenue path**, in **42 s** for **44,370 µ$ ($0.044)**. Consumer and agent leads had no emails or usernames. Agent forums produced 0 ideas that pass, so GitHub carried the agent ideas.

Earlier passes:

Pass `ideas-live-8`: **20 ideas** in **74 s** with **40,800 µ$ ($0.041)** of reported spend.

| Buyer | Ideas |
|---|---|
| business | 10 (2 per pipeline) |
| consumer | 6 |
| agent | 4 |

The strongest new signals:
- GitHub requests for agent/MCP access to developer tools (10 projects), media/design (9) and search/memory (8).
- Consumers asking for organizer/reminder apps (10 posts).

Pass `ideas-live-7` took 45 s; the reviews pipeline (18 businesses, 540 reviews) is the slowest step. Cross-post deduplication was added after pass 8 and is covered by unit tests, but has not run live.

Yelp search returned 503 or was missing from the catalog on every attempt that day, so reviews used the Google fallback.

## Guarantees

- **Spend:** each pass is capped at 60,000 µ$ ($0.06), reserved per call. A rise in a quoted price is refused.
- **Replay:** results are saved to `var/scout/ideas/<request-id>.json`, which Git ignores. Rerunning the same ID replays the file with no paid calls. A `.started` marker without a result blocks a blind paid retry.
- **Nothing is sent:** no outreach and no Foundry write. Leads have `contact_verified: false`.

## Not done yet

- **Live Scout handoff not run yet.** The prompt (`agents/prompts/scout.md`), output schema and collector now cover all three buyer types, up to 5 clusters, and require `buyer_type`, `channel` and `revenue` on every lead. Running it needs `pnpm scout apply`, which updates the shared live `scout` agent.
- **Agent revenue is unverified.** Listing a hosted tool as a paid provider (Monid/x402) must be checked before funding an agent company.
- **GitHub leads include the owner in the repository path** (`owner/repo`). That is a public project identifier, but for personal accounts it names a person.
- **Weak signals:** an `http://` link may redirect to https. App-review wishes include praise that mentions a feature. Treat ideas as candidates for Compliance and Creator, not conclusions.
