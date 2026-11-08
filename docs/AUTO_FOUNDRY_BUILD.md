# Auto Foundry: what to build and how to build it on Naïve

Written against the Naïve Managed Agents docs (usenaive.ai/docs) on Nov 7, 2026. Anything marked **verify** is something the docs leave unclear; check it in hour one.

---

## 0. Hour-one results (Nov 7, against our live org)

We ran these with CLI 1.0.3 on the Pro plan. The whole set cost about $0.012.

| Check | Result |
|---|---|
| CLI login | Works with `naive login --email … --password …`. The dashboard has no API key page; mint keys with `naive keys create --name … --scopes …` after logging in. The API host is `api.vetta.sh` (Vetta is Naïve's older name, and the CLI also installs as `vetta`). |
| Spawn and kill through the Platform MCP | **Works.** The endpoint is `https://api.vetta.sh/v1/mcp` (JSON-RPC, 368 tools). `agents_create` made an agent, `agents_patch` set its budget to 0, and `agents_delete` removed it. The catalog also has `boards_create_card`, `apps_create`, `apps_create_deployment`, `identities_create`, `identities_create_inbox` and `deployments_create`, so `foundry.spawn` can do every step. |
| Budgets in the API | Micro-dollars: `budget: { cap_micro_usd, max_task_micro_usd, period }`. `cap_usd` is rejected. |
| An agent calling the Platform MCP | Not tested yet. An agent's MCP auth comes from a vault credential (`static_bearer`) matched by URL, never from the agent config, so this needs an API key stored in a vault. Declaring the `vetta` server needs the `admin` scope. |
| App MCP tools for agents | Documented as native: set `"mcp": "/mcp"` on a fullstack app and every agent allowed to use the app gets `<app>.<tool>`. The platform mints the bearer and pushes it into the app as `VETTA_MCP_TOKEN`. No `mcp_servers` entry is needed on the agent. |
| Data: Google Maps | **Works.** `naive data search "google maps places businesses" --domain search` finds "Google Maps Results" ($0.002 per call). A run for SF dentists returned 5 listings, each with a website. Tool ids change on every search, so search and run in one step. |
| Social data (X) | **Blocked.** Search lists the X tools, but `describe` and `run` both answer `not_found: no such data tool`, through `social-data` and through `data --domain social`. Ask Naïve staff. |
| Static app hosting | **Works.** `naive app create <name> --type frontend_only`, then `naive app deploy <app_id> <dir>`. Apps are served on Vercel at `https://<name>-<org-suffix>-naive-<hash>.vercel.app`, not `<name>.naive.run`. |
| Browser form submission | **Works.** A computer with `--allow-writes`, limited by `--allowed-domains` to our probe app, ran `goto`, `type` three times and `click`, and `extract` read back the page's confirmation text. Only deterministic actions were used. |
| Payments | Naïve apps have their own payments, and they're enabled for our org: the foundry app's payments answer `stage: not_started` (Nov 8). **Decided in #15:** they replace our own Stripe account. `checkout_link` opens store checkouts with the app's own key, and the paid event lands on `/api/orders/events`. Onboarding is owner-only, from the Studio, and it failed on a setting in Naïve's Stripe platform account. So the app also takes payments through our own Stripe account when `STRIPE_SECRET_KEY` is set, with events on `/api/stripe/webhook`. See [the contract](foundry-contract.md), section 6. |
| System email domain | Created after renaming the org to "Auto Foundry": `auto-foundry-03s9ve.usenaive.ai` (`dom_5kd50djzyfgvdrd024kr8zdt0q`). `naive identity domain connect` with no `--domain` makes it; `naive identity domain verify --domain <id>` advances it. It went `active` with DNS provisioned and inbound verified about 70 seconds after creation. |
| X account and Slack logins | Not done. A person has to connect them. |

Still to check: an agent session calling the Platform MCP, payments onboarding, a fullstack app (can it run Next.js?), and X social data with Naïve staff.

---

## 1. What Naïve can and cannot do (the parts that matter for us)

### Can

| Capability | What the docs say | How we use it |
|---|---|---|
| **Agents as versioned configs** | `name`, `model`, `harness` (default `pi`; `claude_code` available), `system`, `tools` (allow/ask/deny), `skills`, `budget` (`cap_micro_usd`, `max_task_micro_usd`, `period` day/week/month; the API rejects `cap_usd`), `handoffs`, `multiagent`. Authored as `.agent.yaml`, created with `naive agent create -f` or `naive agent apply -f`. | Every child is a set of `.agent.yaml` files generated from a template. |
| **Create agents from inside an agent** | The Platform MCP (`https://api.vetta.sh/v1/mcp`) exposes the Managed Agents API as tools. MCP tools default to `ask`; set `allow` explicitly. | This is the spawn primitive. The CEO creates agents, boards, and deployments through it. |
| **Company board** | Owned by the CEO. Every agent in the org is seated. Cards: `todo / doing / blocked / done`, `assignee` by agent name, `blocked_by`. **Assigning a card starts a session for that agent** (its own budget). Owner gets a digest session of done/blocked cards each tick. | Native orchestration. The CEO writes cards; children work them. No custom queue needed. |
| **Deployments (cron)** | `naive deploy create --agent <id> --cron "*/15 * * * *" --budget-usd 2 --prompt "..."`. Min every 5 min. Per-run budget. `on_idle` webhook. | Scout runs every 15 min. CEO review runs every 2 hours. |
| **Durable sessions** | Start with `agent_id` + `message`. Survive restarts, idle for days. Stop reasons include `awaiting_approval`, `budget_paused`. Raising the budget auto-resumes. | Children's work sessions. |
| **Identity** | Per-agent persona: one free **system domain** per org (subdomain of Naïve's mail domain, verified in ~1 min), email inboxes on it, phone numbers (inbound only, see below), connected social accounts, credential vault. | One identity per child (its own inbox localpart, its own social connection if any). |
| **Email** | `email.inboxes`, `email.read`, `email.send`. **`email.send` is `ask` by default**; set `allow` per agent. $0.0008 per send. Inbound mail wakes the owning agent. Deliverability, warm-up, and rate limits are **not documented**. | Available if we want it. See channels below. |
| **Browser** | Real managed browser. Deterministic actions (`goto`, `click`, `type`, `links`, `extract`, `screenshot`) plus model-driven `act`/`observe`. **`allow_writes` defaults to false**; set true to submit forms. Logins only via vault credential `login:<service>` or a **human-first login context** (a person logs in once in the live view, cookies persist). `signup` is `ask` by default. CAPTCHA solving on by default. `stealth` and `proxy` options. $0.10/hr plus $0.01 per model action. | Contact-form outreach, posting from a logged-in account, verifying deliverables. |
| **Social data (read)** | `data_search` / `data_describe` / `data_run`. ~21 networks including X, Reddit, LinkedIn, TikTok, YouTube. Public posts, profiles, comments, hashtags, trends. $0.003 per call, 25 results per run, 2-minute cap. No login needed. `data_run` is `ask` by default; set `allow`. | **Replaces Apify.** This is the demand scanner's data source. |
| **Data (read)** | 18 domains, ~1,900 endpoints: `search` (web, **maps**, shopping, **app store**), `companies`, `people`, `reviews`, `seo`, `jobs`, `real_estate`, etc. Median $0.0015 per call. | Business listings, app listings, enrichment. |
| **Social (write)** | Connect accounts via hosted portal. **Publishing works for X, LinkedIn, Threads, Bluesky, Facebook, Mastodon.** Reddit, Instagram, TikTok, YouTube connect but publishing isn't stated. `social.post` is `ask` by default; set `allow`. Replies and DMs are not documented. | Post from the connected X account. Replies likely need the browser with a logged-in context. |
| **Apps** | `frontend_only` (static, live immediately) or `fullstack` (Postgres + storage + optional MCP endpoint). Deploy as a file map. Served on Vercel at `https://<name>-<org-suffix>-naive-<hash>.vercel.app` (verified). Custom domains from org-owned domains. An app's MCP endpoint exposes tools to agents as `<app>.<tool>`. | Child sites are `frontend_only` apps. The Foundry dashboard and ledger is one `fullstack` app, and its MCP endpoint gives agents `foundry.log_touch`, `foundry.log_payment`, etc. |
| **Budgets** | Model calls quoted before they run and refused over cap. Compute, web, media metered after (can overshoot slightly). Browser and mobile billed at session end. | Set tight caps per child; the CEO raises or zeroes them. |
| **CRM** | Contacts with `stage` (`lead / talking / proposal / won / lost`), `value_micro_usd`, timeline. `crm.read` / `crm.write` tools when the template declares CRM. | Optional. Our own Postgres is simpler and more demo-friendly. |
| **Legal** | KYC via hosted link, then form a company (WY in the example). Costs credits. `legal.form` / `legal.submit` are `ask`. `naive up` reports but never forms. | Don't incorporate children this weekend. Show the tool exists; say children are "incorporation-ready." |
| **Marketplace** | `list_as_template` tool. Listings earn **15% of each new company's plan payments for 12 months** (payouts over $100, 30-day hold). | Stretch goal: list the best child as a template. It's the franchise model, built into their platform. |

### Cannot (and this changes the plan)

| What I assumed | Reality |
|---|---|
| **Outbound voice calls** | **Not supported.** `capabilities.voice` is always `false` in the messaging API. The $0.08/min line on the pricing page is stale or forward-looking. Phone outreach is dead. |
| **Outbound SMS** | Returns **501** today even after carrier approval ("a text has no price"). Inbound SMS works. Max 3 numbers per org. Dead as a channel. |
| **Paid ads** | Google Search only, early access per org, requires a connected Google Ads account with a developer token. Not reachable this weekend. |
| **Stripe / taking payments** | **Update: apps have payment links, invoices and a payments-received list (see section 0); onboarding not tried yet.** Originally: no payments primitive. Wallet is USDC on Base, testnet by default, marked "coming soon." **We take money with Stripe Payment Links on our own app and a webhook into our fullstack app.** Naïve never touches the money; that's fine and we should say so. |
| **Reddit posting** | Account connects via portal but publishing isn't stated. Treat Reddit as read-only (social data). |
| **Mobile device** | A cloud **Android** phone (not iPhone), `ask` by default, $0.05/min. Usable but not needed for our children. |
| **Spawning "companies"** | There is no company-of-companies object. One org = one CEO board. A "child" is a group of agents plus an identity plus an app, all inside our org, tagged with `metadata.company`. That's what we spawn. |

---

## 2. Design

```
Auto Foundry (one Naïve org)
│
├── CEO              coordinator, owns the company board, Platform MCP = allow
├── Scout            cron every 15 min, data/social-data tools, writes demand clusters
├── Compliance       reviews new copy and scripts; the only agent whose outputs a human approves
│
├── foundry (fullstack app)
│     Postgres: clusters, companies, leads, touches, payments, spend
│     MCP endpoint: foundry.log_touch, foundry.log_payment, foundry.get_metrics, foundry.spawn, foundry.kill
│     /stripe/webhook → payments table
│     / → dashboard (lineage tree, funnel per company, ledger)
│
└── children (spawned by CEO; each = identity + 2–3 agents + 1 frontend_only app)
      ├── co-01  local-site   (Builder, Outreach, Closer)
      ├── co-02  shopify-fix  (Auditor, Outreach, Closer)
      ├── co-03  room-services(Builder, Poster)
      └── ...
```

**Spawn** = the CEO calls `foundry.spawn(template, niche, lead_ids)`. Our app's MCP handler creates the identity, inbox, agents (from `.agent.yaml` templates with the niche filled in), the child's app, and a board card per lead, through the Naïve API. Returns the company id. (Doing it in our app rather than through raw Platform MCP calls keeps the CEO's job to one decision and one tool call, and keeps the API key out of the CEO's prompt.)

**Kill** = `foundry.kill(company_id)` zeroes the child agents' budgets (`naive agent update --budget-usd 0`), marks the company `killed`, logs the reason.

**Metrics** = every child agent logs touches and outcomes with `foundry.log_touch`; Stripe webhook logs payments. CEO reads `foundry.get_metrics` every 2 hours.

---

## 3. Acquisition channels that actually work on Naïve

Ranked by autonomy and fit. No phone, no SMS, no ads.

1. **Contact-form submission via browser** (`allow_writes: true`). Agent `goto`s the business's contact page, fills name/email/message with the sample link, submits. Lands in their inbox from their own system, so our deliverability is irrelevant. Fully autonomous. Works for any business with a website: Shopify stores, local businesses with outdated sites. Risk: CAPTCHAs (auto-solve is on), honeypot fields. Keep volume per child modest.
2. **Email from the system domain** (`email.send: allow`). One free system domain per org, verified in a minute, DNS published for you. Deliverability is undocumented; it's a shared platform subdomain so it probably has some reputation, and $0.0008 per send. Use it as the second touch and for replies to inbound. Keep under ~50 sends per inbox per day.
3. **X posts via `social.post`** from the connected account (`allow`). Public posts only; replies/DMs aren't documented. Use it for the Foundry's own build-in-public feed and each child's "here's what we shipped today" post.
4. **X replies via browser with a human-first login context.** You log into X once in the live view; the agent reuses the cookies with `allow_writes: true`. Agent finds intent posts with social data, builds the sample, replies with the link. This is autonomous after the one login. ToS risk is yours; keep it to 20–40 replies a day with real samples attached.
5. **The room.** Event Slack via browser (same human-first login trick) or you posting. Zero risk.
6. **Inbound.** Every child's inbox and X account is a wake trigger. Anyone who replies gets an agent response within a minute, at 3am. This is the part that will impress judges most, and it's free.

---

## 4. The children (final pick)

| Child | Buyer | Scout source (Naïve data) | Sample (free, delivered first) | Paid | Price | Primary channel |
|---|---|---|---|---|---|---|
| **local-site** | Local businesses with an outdated site | `search` domain, maps results for SF neighborhoods + category; browser screenshots the current site and scores it | A rebuilt one-page site live on its Naïve app URL | Site on their domain + edits | $99 | Contact form → email follow-up |
| **shopify-fix** | Shopify stores under ~50 products | `search` shopping / web results for `myshopify.com`; browser audits | Audit: 3 worst issues with screenshots | Fix pack (alt text, contrast, basics) as theme patch | $79 | Contact form → email |
| **room-services** | Teams at the hackathon | Event Slack, team list | A sharper one-liner or a logo | Landing page, demo script, deck polish | $20 | Slack + in person |
| **app-localize** | Indie devs with English-only listings | `search` app-store results, social data on X `#buildinpublic` | Listing in Spanish | 6-language Fastlane metadata pack | $49 | X reply (browser, logged-in) → email |

Dropped: scrape-on-demand (its channel was Reddit, which is read-only here), anything needing phone.

Payments: Naïve store checkouts on the foundry app, one per lead, with `order_ref` = `<company_id>:<lead_id>`, and the paid event to `/api/orders/events` (decided in #15). Our own Stripe account, with Checkout sessions and `/api/stripe/webhook`, is the fallback while Naïve's onboarding is broken.

---

## 5. Build steps

### Hour 0–1: verify before building
- `npm i -g @usenaive-sdk/cli@latest`, `naive login`. Check plan: Standard is $20/mo with $20 credit; the trial gives $10. Add credits now; media, browser, and data are metered.
- `naive identity domain connect` (no `--domain` means the free system domain) → wait for `provisioned`. Confirm the domain name you got.
- Confirm Platform MCP: create a throwaway agent with `mcp_servers: [{ type: "url", name: "vetta", url: "https://api.vetta.sh/v1/mcp" }]` and permission `allow`; ask it to list agents. **verify** it can create an agent.
- Confirm `data_run` works (`naive data search "google maps places" --domain search`, describe, run with a real query). A `501 feature_not_configured` means the org isn't enabled; ask Naïve staff in the room.
- Confirm social data (`naive social-data search "tweets search" --platform x`).
- Create a computer with a browser, `allow_writes: true`, and submit a form on a test page.
- Connect your X account to an identity via the social portal. Set up a human-first browser login context for X and for the event Slack.
- Confirm app URL pattern by deploying a hello-world `frontend_only` app.

### Hour 1–3: the foundry app
- `naive app create --name foundry --type fullstack --mcp /mcp` (or via config). Next.js or plain Node.
- Tables: `clusters(id, label, source, signal_count, unserved_score, created_at)`, `companies(id, template, niche, status, spawned_at, killed_at, reason)`, `leads(id, cluster_id, company_id, name, url, contact_url, email, data jsonb)`, `touches(id, company_id, lead_id, channel, kind, cost_micro_usd, at)`, `payments(id, company_id, lead_id, amount_cents, stripe_id, at)`, `spend(company_id, agent_id, micro_usd, at)`.
- MCP tools on `/mcp` (bearer `VETTA_MCP_TOKEN` injected by platform): `log_touch`, `log_payment`, `get_metrics(company_id?)`, `spawn(template, niche, lead_ids)`, `kill(company_id, reason)`, `list_clusters`.
- `/stripe/webhook` → `payments`.
- `/` dashboard: lineage tree (spawned/killed with reasons), per-company funnel (leads → touches → replies → paid), spend vs revenue, CEO log.

### Hour 3–5: Scout
`scout.agent.yaml`:
```yaml
name: Scout
model: <cheap model id from `naive models`>
harness: pi
system_file: ./prompts/scout.md   # find clusters, write leads, never contact anyone
tools:
  default_config: { permission: deny }
  configs:
    data_search: { enabled: true, permission: allow }
    data_describe: { enabled: true, permission: allow }
    data_run: { enabled: true, permission: allow }
    web_search: { enabled: true, permission: allow }
    web_fetch: { enabled: true, permission: allow }
    apps: { enabled: true, permission: allow }   # foundry.* tools arrive through the foundry app's MCP endpoint
budget: { cap_micro_usd: 3000000, max_task_micro_usd: 500000, period: day }
```
Then `naive agent apply -f scout.agent.yaml` and `naive deploy create --agent <id> --cron "*/15 * * * *" --budget-usd 0.3 --window loose --prompt "Run one scouting pass. Write new leads and update cluster counts via foundry tools."`
Set `foundry.*` MCP tools to `allow` in `configs` (MCP tools default to `ask`).

### Hour 5–8: the local-site child, by hand first
Three `.agent.yaml` templates with `{{niche}}`, `{{company_id}}`, `{{identity}}` placeholders:
- **Builder**: `bash`, files, `apps` (allowed_apps: the child's app), `browser` read-only (screenshot the current site), `generate_image` for a hero if needed, `foundry.*`. Budget $4/day, $1/task.
- **Outreach**: `browser` with `allow_writes: true` and `allowed_domains: ["*"]`, `email.send: allow`, `foundry.*`. Budget $2/day, $0.3/task. System prompt contains the message template and the rule: one contact-form touch, one email follow-up at +20h, then stop.
- **Closer**: `email.read`, `email.send: allow`, `apps` (connect custom domain), `foundry.*`. Woken by inbound email. Budget $2/day.

Manual run: create identity + inbox, create the three agents, create the child app, put 10 leads on cards assigned to Builder. Watch it build a site, hand off to Outreach via a card, submit a form. Fix the prompts until the site looks good and the form submission lands.

### Hour 8–10: spawn and the CEO
- Move the manual steps into `foundry.spawn` (your app calls the Naïve API: identities, emails, agents, apps, boards/cards).
- `ceo.agent.yaml`: `multiagent: { type: coordinator, board: true }`, tools: `foundry.*` allow, `board_read/board_write`, nothing else. System prompt is the policy: spawn when a cluster has ≥40 leads and no company; kill when a company has ≥150 touches and 0 payments, or cost per reply > $3; raise a child's budget 2x when it has a payment; log one line of reasoning per decision.
- `naive deploy create --agent <ceo> --cron "0 */2 * * *" --budget-usd 0.5 --prompt "Review metrics, spawn or kill per policy, log reasoning."`
- Spawn children 2 and 3 **through the CEO**, not by hand. The lineage has to be real.

### Hour 10–12: Compliance and polish
- **Compliance**: first reduce up to 20 saved Scout ideas to 8–12 interesting experiments in one quick call. Drop obvious illegality and clear practical impossibility; flag uncertainty without demanding proven demand, margins, checkout or verified API access. B2B, B2C and B2A are eligible. Before real-world action, qualify selected opportunities and their concrete offers for legality, monetization, delivery and truthful outreach under the detailed rules. The current [foundry contract](foundry-contract.md) defines the idea screen, later approval and spawn handoff; the [runbook](compliance.md) covers setup and validation.
- Dashboard: make the lineage tree and the "decisions while you slept" log the hero of the page.

### Overnight
Leave it. Don't touch the prompts. The gap in your commit log while the dashboard moves is the autonomy proof.

### Sunday morning
- CEO's 8am run should kill the worst child and spawn one from a new cluster. If it doesn't, the thresholds are wrong; fix the policy prompt, not the outcome.
- Write the Show HN post from the dashboard numbers. You post it (HN bans bots). Draft it with an agent so you can say that too.
- Stretch: `list_as_template` on the best child. "We listed our winner on Naïve's marketplace, where it earns us 15% of every company spawned from it."

---

## 6. The demo (3 minutes)

1. Dashboard: lineage tree. "Scout found N clusters. The CEO spawned 6 companies, killed 2. Here's why, in its words."
2. One child, deep: a lead's outdated site screenshot, the rebuilt site live, the contact-form submission log, the inbound reply, the Closer's answer at 2:41am, the Stripe payment.
3. Live: a judge names a business category and neighborhood. Scout finds 10, Builder ships one site on its app URL while you talk (you'll have pre-warmed the session). Outreach submits the form.
4. The policy slide: "We wrote 40 lines of rules and set a $60 budget. Everything else on this screen was decided by the company."
5. The ask: "Private equity buys companies and strips the back office. We skip the buying."

---

## 7. Open risks, in order

1. **Spawn via API from inside our app**: the docs document `agents.create`, `emails.create`, `apps.create`, board card creation. They don't document a one-shot "company" create. Our `foundry.spawn` stitches 6–8 calls; expect one of them to need an org-level permission or a scope we don't have. Test in hour one.
2. **Browser form submission reliability**: CAPTCHA, honeypots, JS-heavy forms. Expect 50–70% submit success. Log failures as touches with `kind: form_failed` so the CEO sees the channel cost.
3. **Email deliverability on the shared system domain**: unknown. If replies are zero by Saturday night, drop email to replies-only and lean on forms + X.
4. **Feature flags**: data, social data, ads, legal, wallet all return `501 feature_not_configured` where not enabled for the org. Naïve staff are in the room; ask early.
5. **Budget overshoot**: browser and media bill at session end, so a runaway Builder can exceed its cap. Keep `max_task_usd` tight and have the CEO watch `spend`.
6. **X account risk**: the logged-in browser context is your real account. 20–40 real-sample replies a day is defensible; 200 is a ban.

---

## 8. One-line answer to "what did you build"

An autonomous holding company on Naïve: a Scout that finds demand, a CEO that spawns agent-run companies to serve it and kills the ones that can't acquire customers, and children that win business by delivering the finished product before asking for money. No phone, no ads, no human in the loop after the rules were written.
