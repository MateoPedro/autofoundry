# Foundry contract

Status: **draft for #8**. Felix and Mateo both approve it before anyone builds against it. Change it through a PR that both of us review.

The foundry is the fullstack Naïve app that every other piece talks to. Agents call its MCP tools, the dashboard reads its metrics, and spawning, funding and killing run through it. This document fixes what both sides depend on: who decides what, the tables, the tools, the shared crew, and the payment path. Anything not written here is left to whoever owns the issue.

Where this contract and [the build doc](AUTO_FOUNDRY_BUILD.md) disagree, this contract wins. It replaces the build doc's single CEO and its four fixed templates (section 1). A company has no agents of its own: seven fixed agents serve every company (section 4). [Operations](operations.md) covers the Launch and End switch and the rollout. Facts marked **(verified)** were checked against our org on Nov 7; see section 0 of the build doc.

## 1. Who decides what

One parent, the foundry, runs seven fixed agents: Scout, Compliance, Creator, VC, Outreach, Closer and Feedback. The count never changes, however many companies exist. A company is rows in the foundry's database (an offer, leads, samples, a grant, a status and decisions), and the seven agents work on those rows. No person approves anything after the rules file is written.

```text
Scout ──────▶ Compliance ──────▶ Creator ──────────▶ VC ──────▶ Outreach ──────▶ Closer
4 playbooks   quick screen:      writes an offer,    funds, adds  sends the       answers replies,
every 2 h,    ~10 ideas →        opens the company   to, or kills first message   sends checkout
~10 ideas     8–12 approved      and builds a        each         from the       links, delivers
                                 sample per lead     company      shared inbox   what was bought
                                 Feedback turns VC's fund and kill decisions into notes for Scout.
```

Two timers start work: Scout every 2 hours and VC every 5 minutes. Every other step starts when the step before it finishes, through a board card the foundry creates (section 4).

1. **Scout** finds demand and writes clusters and leads. It never contacts anyone.
2. **Compliance** runs only the **quick idea screen** ([rules/idea-screen.md](../rules/idea-screen.md)). The foundry wakes it with a card when the last of a cycle's Scout runs finishes: `screen_batch` cuts the batch of about 20 pending clusters to **8–12 approved experiments**, rejects only obvious illegality or clear impossibility, and leaves lower-priority ideas pending. B2B, B2C and B2A are all eligible. Rejected clusters stop here. *(Owner policy, Nov 8: this replaces the detailed per-cluster review.)*
3. **Creator** is woken by a "Design a company" card for an approved cluster nobody serves. It writes an **offer** for it (section 5), and **offers are approved on submission** (owner policy): there is no separate offer review, so `propose_offer` only checks the channel and `{{sample_url}}`. It then calls `spawn`, which writes rows only: the company, its first 5 leads and a `spawn` decision. Creator builds a free sample page for each of those leads with `publish_sample`. Once each lead has a sample (or a logged failure), the company is `proposed`.
4. **VC** runs every 5 minutes. It calls `reconcile` first, which hands out any card the records say is missing. It then reviews proposed companies. Its first grant rests on the offer, the samples and the cluster's evidence, since there are no results yet. A first grant sets the company `active` and hands each sampled lead to Outreach. A proposed company VC declines is killed, so its slot frees for the next cluster.
5. **Outreach** is woken by a "Contact" card per lead. It sends the offer's first message from the shared inbox and logs the touch. The sweep wakes it once more, about 20 hours later, for the follow-up if there is no reply.
6. **Closer** owns the shared inbox, and an inbound email wakes it. It answers, sends a `checkout_link`, and delivers the product when a "Deliver" card arrives after payment.
7. **VC** keeps watching results, grants more to companies that convert, and kills the ones that don't. A grant is also the company's spending limit (section 4).
8. **Feedback** is woken by each VC fund or kill and writes a note for Scout's memory ([scout-feedback](scout-feedback.md)).

Every decision by Compliance, Creator and VC is written to `decisions` with a one-line reason. The dashboard shows them as one log.

One switch, **Launch** and **End**, starts and stops all seven agents together (section 4, [operations](operations.md)).

### What makes an offer valid

Agents must be able to run it end to end with no person involved. Compliance rejects any offer that fails one of these:

- **The product is digital**, and agents build it with tools Naïve gives them: a website, an audit, a document, translated text, code.
- **The channel is one we can run:** `contact_form` and `email` today, and `x_reply` once X works (#13). An offer can't invent a channel.
- **Delivery is by email or a link.** No calls, meetings, shipping or in-person work.
- **The buyer can be a business, an individual consumer, or an autonomous agent.** Evidence must identify the buyer's need and a supported way to reach or serve that buyer.

### Buyer eligibility for Compliance

B2B (business buyers), B2C (individual consumers) and B2A (agent buyers) are all in scope. Buyer type alone is never a rejection reason. Compliance applies the same checks to each: supported evidence, truthful claims, a digital product agents can deliver, and acquisition, payment and delivery routes that are enabled and authorized for that buyer.

For B2A, review the interface the buyer expects (for example, an API, a file or structured output) and whether the purchase and delivery flow works with the tools and permissions actually available. An agent's identity alone does not establish a need, purchasing ability or permission to spend.

Evidence from consumer reviews may still support a B2B offer to the business being reviewed. Review the intended buyer of our offer separately from the person or agent who supplied the demand signal.

### Legal and monetization review before launch

Compliance screens both clusters and offers for legal risk in the intended seller/buyer jurisdictions: source and content rights, commercial reuse, privacy/consent, outreach and advertising rules, regulated activities/licensing, payment and refund obligations. Record applicable primary sources and the facts supporting their applicability. `clear` means the specified activity fits the [owner rules](../rules/compliance.md), not a legal opinion or universal legality. Missing jurisdiction, rights or unresolved regulatory questions remain pending with a precise research/specialist-review question; demonstrated violations are rejected. A buyer's industry alone is not the product's regulatory classification.

Compliance also asks **can we monetize this?** Identify the payer, valuable digital deliverable, evidence of existing spend/budget or comparable paid products, and a bounded price/cost hypothesis. Estimate contribution after discovery, samples for nonbuyers, acquisition, compute/API/hosting, payment fees, delivery/support and refunds; state conversion assumptions. Separate estimated pricing and willingness to pay from observed sales. Unknown payer, pricing or costs stay pending for research; reject an offer as unviable only with supporting evidence. A cluster can qualify with a clearly unverified payment plan; a concrete offer needs an enabled, authorized payment/refund and delivery path before approval, including a compatible buyer interface for B2A.

### Compliance's company shortlist

**Idea-stage screen (owner policy):** the first pass is a quick 20 → 8–12 selection of interesting experiments. It excludes obvious illegality/harm and clear practical impossibility, flags uncertain risks and ranks the remaining ideas. It does not require purchasing intent, proven margins, working checkout or verified acquisition/API access. Those are questions for the next experiment. The screen uses saved Scout summaries in one bounded model call and writes a report, not Foundry approval decisions. Detailed offer/launch gates below still apply before outreach, charging customers or handling their data. See [idea-screen rules](../rules/idea-screen.md).

For each incoming Scout batch, return **8–12 distinct experiments**, each with its source pick, a short selection reason, a first test and any obvious risk flag. Multiple leads for the same opportunity do not count as multiple companies. There is no required mix of B2B, B2C and B2A candidates. Lower priority is a ranking outcome, not a policy rejection. Return an honest shortfall if clear blockers leave fewer than eight.

#### Qualification before launch

The following detailed report qualifies selected opportunities for Foundry approval and the Creator/VC handoff. It is a separate step from the quick idea shortlist.

Each entry identifies its source `cluster_id`, buyer and buyer type, the evidenced need, supporting source links, verified lead count, feasible digital delivery path, and a concise selection reason. Rank eligible candidates by evidence strength and delivery/channel readiness. Report unresolved evidence gaps separately. A valid candidate outside the top 12 is eligible backlog, not a policy rejection.

Each entry also includes legal screening (jurisdictions, primary-source basis, risks) and monetization (payer/value, USD-cent price range and conservative cost, assumptions, pricing evidence and payment readiness). The [Compliance runbook](compliance.md) describes the agent, collected report and bounded deployment workflow.

The count is a target, not permission to invent candidates or weaken review rules. If fewer than eight qualify, return the qualified shortlist, state the shortfall, and identify what additional research is needed. Incomplete evidence stays pending; clear rule violations are rejected with a reason. The existing review API still records individual approve/reject decisions; the shortlist and research gaps are the agent's review report, not a new database status or MCP tool.

Creator turns shortlisted opportunities into concrete offers. Compliance then reviews those offers. Mark an entry **ready for spawn** only when its offer has been approved, and include the approved `offer_id` in that handoff. Compliance recommends and reviews; Creator calls `spawn`, and VC decides which proposed companies receive money.

An 8–12-entry shortlist does not raise the funding pool or concurrency limits below. Candidates wait in the approved backlog and are spawned/funded as policy capacity permits.

Compliance reviews one candidate per hosted run. Incomplete/rejected cases return a short reason and up to three research gaps; full approval evidence remains required. The CLI checkpoints each review and assembles the ranked report deterministically from collected sessions, including explicit failed-run records. There is no model-generated portfolio report step. See the [Compliance runbook](compliance.md).

### Buyer types

How Scout records each buyer type. **Every cluster carries leads**, so `add_leads` works the same way for all three:

| Buyer | What a lead is | Contact route (`contact_url`) | Who pays |
|---|---|---|---|
| **Business (B2B)** | A company | A verified general inquiry form or a public business email | The business, one-time or monthly |
| **Consumer (B2C)** | A public post asking for an app or service (Reddit, X), or, for app-review wishes, the app's developer | The post itself, or the developer's verified contact | Consumers, through a Stripe Payment Link on the product; or the developer |
| **Agent (B2A)** | A GitHub project whose users request agent/MCP access, or a public agent-builder post | The issue or post | AI agents per call for a hosted tool listed in a paid agent catalog; the project maintainer for the integration as a fallback |

A consumer or agent lead is a public demand point, **never a person**: the buyer may be an individual consumer, but the lead records where they asked, not who they are. `name` is the place plus the post title or the repository name, `email` is null, and no username, handle or profile is stored.

Every lead's `data` records:
- `buyer_type`: `business`, `consumer` or `agent`;
- `channel`: `contact_form`, `email`, `x_reply`, `reddit_reply`, `hn_reply` or `github_issue_reply`;
- `revenue`: Scout's revenue hypothesis `{payer, offer, model (one_time | monthly | per_call), price_usd, channel, channel_ready}`. Creator still writes the final offer and price.

A cluster never mixes buyer types. A cluster whose leads lack a revenue path stays pending until Scout supplies one.

**Agents bring in money too.** For agent demand, the default model is per-call payment by agents for a hosted tool, listed where agents already buy tools (Monid's provider catalog, Naïve's data catalog, or an x402 endpoint). Selling the integration to the project's maintainers is the fallback. Listing as a paid provider has **not** been verified yet; that is the first check before funding an agent company.

**Channels not ready yet:** only `contact_form` and `email` run today. `x_reply` waits on #13; Reddit, HN and GitHub replies are not channels yet. Clusters whose leads need them are still recorded, so VC can see the demand, but they cannot be funded until their channel works.

**Proposed interface change (needs Felix, #10):** make `buyer` a first-class column on `clusters` and an input to `add_leads`. Until then it lives in each lead's `data.buyer_type`, which `add_leads` already stores as-is, so no schema change blocks Scout.

### Funding policy

VC's limits live in one database row, `funding_policy` (section 2), and `fund` refuses anything outside them. We set the real numbers after the cost experiment (section 8). Until then: $5 per grant, $10 in total, at most 3 proposed companies waiting and 2 active at once. These placeholders are Claude's call, made while drafting. A grant is also the company's spending limit (section 4): the foundry stops creating billable cards for a company once its crew sessions have cost what VC granted. `budget_split` is no longer used.

## 2. Conventions

- **Ids.** Foundry rows use text ids with a prefix: `cl_` clusters, `of_` offers, `co_` companies, `ld_` leads, `tc_` touches, `py_` payments, `dc_` decisions. Companies also get a short slug: `co-01`, `co-02`, in spawn order.
- **Naïve ids** (`agt_`, `idn_`, `app_`, `eml_`) are stored as given and never parsed.
- **Money.** Costs, budgets and grants are integer micro-dollars (`*_micro_usd`), the unit Naïve's API uses (verified: it rejects `cap_usd`). Payments are integer cents (`*_cents`), the unit Stripe and Naïve app payments use. No field mixes the two.
- **Time.** `timestamptz`, UTC. Tools return ISO 8601 strings.
- **Agent names.** The seven agents are `scout`, `compliance`, `creator`, `vc`, `feedback`, `outreach` and `closer`. Companies have none of their own. Board cards are assigned by agent **name**, so names must be unique in the org.

## 3. Tables

Postgres, in the foundry app's managed database. The app gets its connection string in its environment automatically.

```sql
create table clusters (
  id                 text primary key,              -- cl_...
  label              text not null unique,          -- "SF dentists with outdated sites"
  source             text not null,                 -- tool that found it: google_maps, x, ...
  signal_count       integer not null default 0,    -- leads found so far
  unserved_score     real not null default 0,       -- 0..1, Scout's estimate; how it scores is Scout's call (#11)
  review_status      text not null default 'pending', -- pending | approved | rejected
  review_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table offers (
  id                 text primary key,              -- of_...
  cluster_id         text not null references clusters(id),
  buyer              text not null,                 -- "dental practices in SF whose site has no mobile layout"
  sample             text not null,                 -- what Creator builds for free: "a rebuilt one-page site"
  product            text not null,                 -- what they pay for: "that site on your domain, plus 30 days of edits"
  price_cents        integer not null,
  channel            text not null,                 -- contact_form | email | x_reply
  outreach_message   text not null,                 -- the exact first message, with {{lead_name}} and {{sample_url}}
  follow_up_message  text,                          -- one follow-up, or null
  delivery           text not null,                 -- how the paid product reaches them, by email or link
  review_status      text not null default 'pending', -- pending | approved | rejected
  review_reason      text,
  parent_offer_id    text references offers(id),    -- set when Creator revises a rejected offer or a killed company's offer
  created_at         timestamptz not null default now()
);

create table companies (
  id                 text primary key,              -- co_...
  slug               text not null unique,          -- co-01
  offer_id           text not null references offers(id),
  cluster_id         text not null references clusters(id),
  parent_id          text references companies(id), -- sibling of a company that converted; null otherwise
  status             text not null default 'spawning', -- spawning (samples being built) | proposed | active | killed | failed
  granted_micro_usd  bigint not null default 0,     -- total VC has granted; the company's spending limit
  spawned_at         timestamptz not null default now(),
  funded_at          timestamptz,
  killed_at          timestamptz,
  request_id         text unique                    -- spawn's request_id; a retry with the same one resumes
);

-- Legacy. The per-company spawn wrote every Naïve resource it created here. Nothing writes it now; the spend sync still reads it.
create table company_resources (
  company_id   text not null references companies(id),
  kind         text not null,                       -- agent | identity | inbox | app | card | deployment
  role         text,                                -- legacy: builder | outreach | closer
  naive_id     text not null,
  name         text,                                -- agent name, inbox address, app URL, a card's lead id, or a cron
  created_at   timestamptz not null default now(),
  primary key (company_id, kind, naive_id)
);

-- Each lead's sample page. The foundry serves it at <FOUNDRY_URL>/s/<lead_id>.
create table samples (
  lead_id      text primary key references leads(id),
  company_id   text not null references companies(id),
  html         text not null,
  updated_at   timestamptz not null default now()
);

create table leads (
  id           text primary key,                    -- ld_...
  cluster_id   text not null references clusters(id),
  company_id   text references companies(id),       -- set when a spawn picks the lead up
  name         text not null,                       -- business name, project, or public post; never a person's name
  url          text,                                -- their current site, store or listing
  contact_url  text,                                -- contact form page, if found
  email        text,
  external_id  text,                                -- Google place_id, X post id, ...; used to skip duplicates
  status       text not null default 'new',         -- new | assigned | contacted | replied | paid | dead
  sample_url   text,                                -- the free sample built for them: <FOUNDRY_URL>/s/<lead id>
  data         jsonb not null default '{}',         -- whatever Scout found, plus buyer_type, channel and revenue (section 1, buyer types)
  created_at   timestamptz not null default now(),
  unique (cluster_id, external_id)
);

create table touches (
  id              text primary key,                 -- tc_...
  company_id      text not null references companies(id),
  lead_id         text references leads(id),
  agent_name      text not null,                    -- outreach | closer | creator
  channel         text not null,                    -- contact_form | email | x_reply
  kind            text not null,                    -- sample_delivered | sent | failed | reply_received | reply_sent | delivered
  detail          text,                             -- one line: the failure reason, the sample URL, ...
  cost_micro_usd  bigint not null default 0,
  message_id      text,                             -- the inbound email's inb_ id, on reply_received
  at              timestamptz not null default now()
);

create table payments (
  id              text primary key,                 -- py_...
  company_id      text not null references companies(id),
  lead_id         text references leads(id),
  amount_cents    integer not null,
  refunded_cents  integer not null default 0,
  source          text not null,                    -- naive_checkout | stripe
  external_ref    text not null unique,             -- checkout_ref or Stripe id; a replayed event can't double-count
  livemode        boolean not null,
  at              timestamptz not null default now()
);

-- Each checkout checkout_link opened. A paid event names only the checkout, so the app finds the lead here.
create table checkouts (
  ref           text primary key,                   -- Naïve's checkout_ref
  company_id    text not null references companies(id),
  lead_id       text not null references leads(id),
  amount_cents  integer not null,
  url           text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

-- Spend per agent, copied from Naïve; the foundry-wide figure. Agents never report their own spend.
-- Each sync appends a row, so the dashboard can chart spend over time; the latest row per agent is current.
create table spend (
  company_id   text references companies(id),       -- null for the shared crew; a company's spend is in session_spend
  agent_id     text not null,
  agent_name   text not null,
  micro_usd    bigint not null,                     -- total spend so far, as Naïve reports it
  synced_at    timestamptz not null default now(),
  primary key (agent_id, synced_at)
);

-- Every decision by Compliance, Creator and VC, including choosing to do nothing.
create table decisions (
  id                text primary key,               -- dc_...
  agent             text not null,                  -- compliance | creator | vc
  kind              text not null,                  -- approve | reject | spawn | fund | kill | hold
  cluster_id        text references clusters(id),
  offer_id          text references offers(id),
  company_id        text references companies(id),
  amount_micro_usd  bigint,                         -- fund only
  reason            text not null,                  -- one line, in the agent's words
  at                timestamptz not null default now()
);

-- Exactly one row. We change it after the cost experiment; fund and spawn enforce it.
create table funding_policy (
  id                     integer primary key default 1 check (id = 1),
  pool_micro_usd         bigint not null,           -- total VC may grant, ever
  grant_micro_usd        bigint not null,           -- size of one grant
  max_grants_per_company integer not null,
  max_proposed           integer not null,          -- unfunded companies waiting at once
  max_active             integer not null,
  budget_split           jsonb not null,            -- unused since the shared crew
  updated_at             timestamptz not null default now()
);

insert into funding_policy values
  (1, 10000000, 5000000, 3, 3, 2, '{"builder": 0.5, "outreach": 0.3, "closer": 0.2}', now());

-- Added by migrations/0009_shared_crew.sql.

-- Exactly one row: whether the company is running, and when that last changed (Launch and End).
create table foundry_state (
  id          int primary key check (id = 1),
  running     boolean not null default false,
  changed_at  timestamptz not null default now()
);

-- The seven agents. pnpm crew setup fills it. Closer's row carries the shared identity and inbox.
create table crew (
  role           text primary key,                  -- scout | compliance | creator | vc | feedback | outreach | closer
  agent_id       text not null,
  board_id       text not null,                     -- the agent's own board; its cards go here
  identity_id    text,
  inbox_id       text,
  inbox_address  text
);

-- Every piece of crew work. The key dedupes: one card per piece of work. A pending row is a card
-- the foundry has written down but not yet sent to Naïve; the sweep sends it.
create table work_cards (
  key         text primary key,                     -- creator:design:<cluster_id>, outreach:contact:<lead_id>, ...
  role        text not null,
  company_id  text references companies(id),        -- set for cards billed or closed with a company
  cluster_id  text,                                 -- set for Design and Revise cards
  title       text not null,
  body        text not null,
  billable    boolean not null default false,       -- charged to the company's grant
  board_id    text,                                 -- set once the card is on Naïve
  card_id     text,
  status      text not null default 'pending',      -- pending | open | closed
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

-- Each crew session and what it cost, charged to a company when its card or email names one.
create table session_spend (
  session_id  text primary key,
  agent_name  text not null,                        -- creator | outreach | closer
  company_id  text references companies(id),        -- null: parent overhead
  micro_usd   bigint not null,
  started_at  timestamptz not null,
  synced_at   timestamptz not null default now()
);

-- Inbound emails the Closer handled without a lead (dismiss_inbound).
create table inbound_seen (
  message_id  text primary key,
  outcome     text not null,
  at          timestamptz not null default now()
);
```

## 4. The shared crew

Every company is served by the same seven agents. Spawning a company creates nothing in Naïve: no agents, no app, no identity and no inbox. What differs per company is the offer, which the agents read from the foundry when a card names the company.

| Agent | Woken by | Tools (`foundry.*`, then Naïve tools) | Daily cap, per task |
|---|---|---|---|
| `scout` | Four schedules, every 2 hours | `add_leads`, `list_clusters`, `monid_read`, `scout_memory`; `web_search`, `web_fetch`, `data_*` | $15, $0.50 |
| `compliance` | A "Screen" card (screen mode) | `screen_batch`, `submit_screen` | $3, $0.50 |
| `creator` | "Design", "Sample", "Revise" and "Sibling" cards | `list_clusters`, `list_offers`, `review_context`, `propose_offer`, `spawn`, `find_lead`, `publish_sample`, `log_touch`, `log_decision`, `get_metrics`, `get_company`; `web_fetch` | $2, $0.50 |
| `vc` | One schedule, every 5 minutes (`*/5 * * * *`) | `reconcile`, `list_clusters`, `fund`, `kill`, `log_decision`, `get_metrics`, `get_company` | $15, $0.50 |
| `feedback` | A "Write feedback" card | `feedback_context`, `scout_memory`, `write_feedback`, `compact_feedback`, `get_metrics` | $2, $0.50 |
| `outreach` | "Contact" and "Follow up" cards | `find_lead`, `get_company`, `log_touch`; `email.inboxes`, `email.send`, `browser` (with `allow_writes`) | $10, $0.30 |
| `closer` | An email to the shared inbox, "Answer email" and "Deliver" cards | `find_lead`, `get_company`, `log_touch`, `checkout_link`, `publish_sample`, `dismiss_inbound`, `read_inbound`; `email.inboxes`, `email.send` | $10, $0.30 |

The caps are `ROLE_BUDGETS` in `src/lib/server/foundry/roles.ts`, set per day. Launch restores them and End sets them to 0. The configs are `agents/<role>.agent.yaml` with prompts in `agents/prompts/`. Scout and Compliance are applied with `pnpm scout apply` and `pnpm compliance apply --mode screen`, the others with `pnpm parent <role> apply` (see [operations](operations.md)). VC's schedule is the only one in `scripts/parent-config.ts`; the other four parent agents have `cron: null`. Scout's four schedules are in `scripts/scout-playbooks.ts`. Every schedule is created off.

Closer runs in the `immediate` window so a reply doesn't queue. The others run `loose`. Every config sets `default_config: { permission: deny }` and allows only the tools above.

### One identity and inbox

`pnpm crew setup` creates one identity (`autofoundry`) and one inbox, `hello@<system domain>`, owned by the Closer. Outreach sends from the same inbox. Replies land there, and an inbound email wakes the Closer. No message claims a person wrote it, and the Closer says it is an AI assistant if asked. Neither Outreach nor the Closer gets `email.read`: an inbound email's text arrives in the message that wakes the Closer, and a session that reads an inbox is marked as having read a person's data, after which Naïve holds every call that sends data out for a person's approval (seen Nov 8). For an email the Closer was not woken for, `read_inbound` returns it by id.

### Apps tool

The `apps` tool is set to `deny`, with only the foundry app in `allowed_apps`. Verified Nov 8:

- `allowed_apps` is what makes an app's MCP tools appear. With the foundry app missing from it, an agent gets no `foundry.*` tools.
- The `foundry.*` tools still work when `apps` itself is `deny`.
- With `apps` at `allow`, an agent can `deploy`, `provision`, `set_secret`, `db_query` and `db_migrate` on every app in `allowed_apps`. Naïve ignores `edits_apps: false`: a deploy went through with it set.

So `creator`, `vc`, `feedback`, `outreach` and `closer` hold none of the `apps` tool's own actions. `pnpm scout apply` and `pnpm compliance apply` still set `apps` to `allow` with `edits_apps: false`, which Naïve ignores, so Scout and Compliance can still deploy to the foundry app until those two loaders switch to `deny` as `scripts/parent-config.ts` does.

### Cards

The foundry app wakes an agent by creating a board card assigned to it. Each agent has its own board, recorded in the `crew` table by `pnpm crew setup`. Agents may not get board tools (seen Nov 8: the agents spawned that day couldn't read or move cards), so **a card's title carries every id the agent needs**, and the title arrives in the wake message. The body repeats the title. Prompts tell each agent not to rely on reading or moving the card.

Each card has a key. The foundry records it in `work_cards` and passes it to Naïve, which answers the existing card for a repeated key on the same board. An event and the sweep can both ask for the same work, and only one card exists.

| Event | Wakes | Card title | Key |
|---|---|---|---|
| The last of a cycle's four Scout runs reports idle (`/api/scout-idle`), or the sweep finds a cycle 90 minutes old with no screen | Compliance | `Screen Scout batch <cycle start>` | `compliance:screen:<cycle start>` |
| A screen approves clusters, or the sweep, while a Creator slot is free | Creator | `Design a company for cluster <cluster_id>` | `creator:design:<cluster_id>` |
| A first grant, or the sweep, for a sampled lead nobody has contacted; also `publish_sample` for a lead of an active company | Outreach | `Contact <lead_id> for <company_id>` | `outreach:contact:<lead_id>` |
| A second or third grant that adds leads | Creator | `Sample new leads for <company_id>` | `creator:sample:<company_id>:<grant number>` |
| The sweep: a contacted lead with one `sent` touch at least 20 hours old and no reply, whose offer has a follow-up | Outreach | `Follow up <lead_id> for <company_id>` | `outreach:followup:<lead_id>` |
| VC kills a company whose cluster still has unassigned leads | Creator | `Revise the offer for cluster <cluster_id> after <company_id> was killed` | `creator:revise:<company_id>` |
| A paid event | Closer | `Deliver <lead_id> for <company_id>` | `closer:deliver:<lead_id>` |
| A paid event | Creator | `Consider a sibling of <company_id>` | `creator:sibling:<company_id>` |
| An email to the shared inbox | Closer, woken by Naïve | none | none |
| The sweep: an inbound email with no logged reply or dismissal after 10 minutes | Closer | `Answer email <message_id> from <sender>` | `closer:inbound:<message_id>` |
| VC records a fund or kill decision | Feedback | `Write feedback through <decision_id>` | `feedback:<decision_id>` |

A design card counts against `max_proposed` until Creator spawns from its cluster or logs a decision about it, so the queue never holds more than `max_proposed` companies and designs together. `submit_screen` fills the queue right after it commits, and the sweep fills it again if that wake failed.

`fund`, `kill` and `publish_sample` write their cards down inside their transaction and send them to Naïve after it commits, so an agent never wakes to a change that isn't saved yet. A card that can't be sent, or is woken while the company is stopped, stays pending, and the next sweep sends it. `kill` closes the company's cards except Deliver cards, because a buyer who paid is still served.

### The sweep

`reconcile` works out from the foundry's records what should be happening and creates any missing card. VC calls it first on every pass, and Launch calls it once. It hands out:

- Every pending card, first.
- Creator cards for queued clusters, while there is a free slot. A Design card counts against the slot until Creator spawns from the cluster or logs a decision about it, for at most 6 hours; a cluster gets at most 2 Design cards, and untried clusters go first.
- Creator "Sample new leads" cards for a company with leads that have neither a sample nor a failed touch: a spawning company 2 hours after it spawned, or an active one after a grant. One every 2 hours, 3 at most. VC kills a company still spawning after 12 hours.
- A Compliance card for a Scout batch 90 minutes into its cycle, if none exists. A cycle is due when it has no screen and either a Scout run pinged or a pending cluster has leads saved in it.
- Outreach cards for active companies' sampled leads that have no `sent` touch.
- Follow-up cards for the leads described in the table.
- Deliver cards for paid leads with no `delivered` touch.
- Closer cards for emails to the shared inbox. The sweep reads the inbox's last 100 emails, keeps those from the last 3 days that arrived at least 10 minutes ago, and skips emails Naïve held back as `auto_reply`, `own_persona`, `thread_turn_cap` or `sender_rate_limit`. It compares them with the message ids the Closer logged on touches (`message_id`) or dismissed (`inbound_seen`).

It returns how many cards of each kind it created. While the company is stopped it creates nothing and returns `stopped: true`; Launch's sweep sends what waited. A call that fails because Naïve is down surfaces as `naive_error`; the next pass retries it.

### The switch

One row, `foundry_state`, records whether the company is running and when that last changed. While it says stopped:

- every tool that writes answers `stopped` (`the company is stopped; the owner turns it back on with Launch`). Read tools still answer.
- the foundry creates no card.
- payments are still recorded. The Deliver card is created after the next Launch, by the sweep.

Launch and End change the row and the agents together. [operations](operations.md) lists the steps.

### Spend per company

A company has no agents, so its spend comes from the crew's sessions. The sync reads each Creator, Outreach and Closer session from Naïve (`sessions:read`, `consumed_micro_usd`) into `session_spend` and charges it to a company:

- A session woken by a card carries the woken card ids in its metadata (`metadata.board.digest`, verified Nov 8). The first card with a company names it.
- A session woken by an email carries `metadata.inbound_message_id`. The company is the one whose lead the Closer logged that message against (`touches.message_id`).

Every other session counts as parent overhead. A company's spend is the sum of its sessions in `session_spend`. `get_metrics` and `get_company` refresh the sync when the last one is more than 5 minutes old, and read back the last 24 hours of sessions. The `spend` table still holds each agent's total spend, copied from Naïve, for the foundry-wide figure.

**The grant is the limit.** Creating a card that would be billed to a company (Sample, Contact, Follow up) is refused once the company's spend reaches `granted_micro_usd`, and for a company with nothing granted. Work resumes when VC grants more, or never if VC kills it. Design, Revise, Sibling, Deliver, Answer email, Screen and Feedback cards are not billed to a company, so a payment is always delivered.

### Samples

`publish_sample` stores a lead's page (one self-contained HTML page, at most 100,000 characters) in the `samples` table and sets the lead's `sample_url` to `<FOUNDRY_URL>/s/<lead_id>`. The foundry serves it from the `samples` table at that path, with no redeploy. The page is served with `default-src 'none'`, `sandbox` and `nosniff`, so a sample can't run scripts or submit forms. An unknown lead id answers 404. `FOUNDRY_URL` is the app's public https URL. Without it, `/mcp` and the webhooks answer 500.

### What each agent does

- **Creator** works from a card's title. A "Design" card: read the cluster's leads with `review_context`, write an offer with `propose_offer` (or reuse an approved one), call `spawn`, then build and publish a sample for each lead. A "Sample" card builds samples for leads a later grant added. A "Revise" card writes a revised offer after a kill. A "Sibling" card considers a second company from a converting offer. It reads each lead's site with `web_fetch` and uses only facts it finds. If a site can't be read, it logs a `failed` touch for the lead.
- **Outreach** sends `{{outreach_message}}` through the offer's channel, with the lead's name and sample URL filled in, when a Contact card wakes it. It sends the follow-up when a Follow up card wakes it. It sends no other text, and it logs each touch, including failures. It stops if the lead's status isn't the one the card expects, so a card that wakes it twice doesn't send twice.
- **Closer** owns the inbox. It finds the lead with `find_lead` (by the quoted sample link, the sender's address or name, without a `company_id`), logs the reply with the email's id, answers, and sends a `checkout_link` when the buyer wants to buy. An email that matches no lead, or is spam, it dismisses with `dismiss_inbound`. When a Deliver card arrives, it delivers the product as the offer's `delivery` describes and logs `delivered`. A killed company still takes replies and deliveries.

`{{lead_name}}` and `{{sample_url}}` stay in the offer's messages for Outreach to fill per lead.

## 5. MCP tools

The app serves them at `/mcp` and rejects any call whose `Authorization: Bearer` is not `VETTA_MCP_TOKEN`. Agents see them as `foundry.<tool>`.

The platform injects the same token for every agent, so **the app can't tell which agent called**. Access is set on each agent's config instead: Naïve's docs say app tools are "gated by the same `default_config` + `configs` allow/ask/deny as every other tool", so permissions are per tool. Each agent allows only its own tools from this table. Tools that write take the caller's name so the record shows who did it. The app refuses every tool marked as writing while the company is stopped.

| Tool | Who may call it | Writes | Owner |
|---|---|---|---|
| `add_leads` | Scout | yes | #10 |
| `list_clusters` | Scout, Creator, VC | no | #10 |
| `monid_read` | Scout | yes | #11 |
| `list_offers` | Creator | no | #17 |
| `screen_batch`, `submit_screen` | Compliance (screen mode) | yes | #11 |
| `list_pending` | Compliance (audit and enforce modes) | no | #10 |
| `review_context` | Compliance (audit and enforce modes), Creator | no | #18 |
| `review` | Compliance (enforce mode) | yes | #10 |
| `propose_offer` | Creator | yes | #10 |
| `spawn` | Creator | yes | #16 |
| `fund` | VC | yes | #16 |
| `kill` | VC | yes | #16 |
| `reconcile` | VC | yes | shared crew |
| `log_decision` | Creator, VC | yes | #10 |
| `get_metrics` | Creator, VC, Feedback, dashboard | no | #10 |
| `get_company` | Creator, VC, Outreach, Closer, dashboard | no | #10 |
| `log_touch` | Creator, Outreach, Closer | yes | #10 |
| `find_lead` | Creator, Outreach, Closer | no | #10 |
| `publish_sample` | Creator, Closer | yes | #12 |
| `checkout_link` | Closer | yes | #15 |
| `dismiss_inbound` | Closer | yes | shared crew |
| `read_inbound` | Closer | no | shared crew |
| `scout_memory` | Scout, Feedback | no | [scout-feedback](scout-feedback.md) |
| `feedback_context` | Feedback | no | [scout-feedback](scout-feedback.md) |
| `write_feedback` | Feedback | yes | [scout-feedback](scout-feedback.md) |
| `compact_feedback` | Feedback | yes | [scout-feedback](scout-feedback.md) |

A tool marked as writing answers `stopped` while the company is stopped (section 4). A read tool still answers.

The foundry's server code calls the Naïve API for everything that touches agents: waking an agent with a card, Launch and End (budgets, schedules, parked cards), reading the shared inbox, and the spend sync. An app's own key comes from an agent calling `apps.request_access` and the owner approving the card, and it lands in the app's environment as `NAIVE_API_KEY`. **Verified in #10: `apps.request_access` accepts only read scopes** (`agents:read`, `sessions:read`, `billing:read`, `files:read`, `files:write`). That covers reads, but not creating cards or changing budgets, which need `agents:write`. **Decided (Felix, Nov 7):** the app holds an org API key as the app secret `NAIVE_WRITE_KEY`. Its scopes are `agents:read`, `agents:write`, `billing:read` and `sessions:read`. Reading an agent's spend needs `billing:read` (verified: the read-only key got `403: this API key is missing the billing:read scope`), and charging a session to a company needs `sessions:read`. The key can't start sessions: that needs `sessions:write`, which only an admin can grant. The owner runs `pnpm foundry:key` (or `--replace` to revoke and remake it, which is how an existing key gains `sessions:read`), which creates the key and stores it on the app without printing it, then the app is redeployed. The platform-approved read-only key stays in `NAIVE_API_KEY` as a fallback. Without `NAIVE_WRITE_KEY`, tools that need to create a card answer `internal`.

Every tool returns JSON. A failure returns `{ "error": { "code": "...", "message": "..." } }` with MCP's `isError: true`. Codes: `not_found`, `invalid`, `conflict`, `not_approved` (the cluster or offer hasn't passed Compliance), `policy` (the funding policy refuses it; the message says which limit), `killed`, `stopped` (the company is stopped; Launch turns it back on), `naive_error` (a Naïve call failed; the message says which), `internal` (anything else; the message is fixed and the details go to the app's logs). An id that doesn't exist returns `not_found`, including one that only a foreign key catches.

Naïve cuts tool results longer than 8,000 characters, so every tool's defaults keep it under that, and a result that would still be longer comes back as an `invalid` error asking for a smaller limit instead of being cut. Tools that list take a `limit`; the defaults are in each example below.

### Scout

**`add_leads`** upserts the cluster by `label`, inserts leads, and updates `signal_count`. A new cluster starts `pending` review. It skips a lead whose `external_id` or url already exists in the cluster, so a business is never contacted twice. Urls are compared and stored in one form: lowercase host without `www.`, no trailing slash, no fragment.

```jsonc
// input
{ "cluster": { "label": "SF dentists with outdated sites", "source": "google_maps", "unserved_score": 0.8 },
  "leads": [ { "name": "Folsom Street Dental", "url": "https://...", "contact_url": "https://.../contact",
               "email": null, "external_id": "ChIJ...", "data": { "rating": 4.6, "issues": ["no mobile layout"] } } ] }
// output
{ "cluster_id": "cl_...", "added": 9, "skipped": 1, "signal_count": 43, "review_status": "pending" }
```

**`list_clusters`**

```jsonc
// input
{ "review_status": "approved", "unserved_only": true, "min_signal_count": 0, "limit": 20 }   // limit at most 30
// output
{ "clusters": [ { "id": "cl_...", "label": "...", "source": "google_maps", "signal_count": 43,
                  "unserved_score": 0.8, "review_status": "approved", "company_ids": [] } ] }
```

**`monid_read`** runs one Monid search from a fixed allowlist of read sources: `reddit`, `x_search`, `github_issues`, `hackernews` (`src/lib/server/monid.ts`). The caller picks only the source and the query, never a provider or endpoint, because Monid's catalog also runs write and provisioning endpoints. The app re-inspects the price before each billed run and refuses a rise. It writes each call to `monid_reads` at the worst-case price before the run starts, and refuses with `policy` once the UTC day's Monid spend would pass `MONID_DAILY_CAP_MICRO_USD` (default 500,000). A lost or failed run is never retried. Items carry no author names, handles or profile links. Needs `MONID_API_KEY` as an app secret; without it the tool returns `policy`.

```jsonc
// input
{ "source": "reddit", "query": "\"is there an app\" OR \"wish there was an app\"" }
// output
{ "source": "reddit", "query": "...", "run_id": "01M...", "status": "COMPLETED", "http_status": 200, "cost_micro_usd": 350,
  "spent_today_micro_usd": 4200, "daily_cap_micro_usd": 500000,
  "items": [ { "id": "...", "url": "https://www.reddit.com/r/apps/comments/...", "subreddit": "apps", "title": "...", "text": "...", "score": 4, "comments": 2, "created_at": "..." } ] }
```

**Scout cycle → Compliance screen.** Scout runs every 2 hours: four playbooks (`maps`, `reviews`, `appstore`, `jobs`), 5 minutes apart. Every Scout deployment's `on_idle` webhook posts to `/api/scout-idle?token=SCOUT_IDLE_TOKEN`, which records the ping in `scout_pings`. The fourth ping of a cycle creates Compliance's "Screen" card (section 4), so the screen starts when Scout finishes. If a run hangs, the five-minute sweep creates the card once the cycle is 90 minutes old. Each cycle is screened once, and the card key stops a late or extra ping from waking Compliance twice.

### Compliance

**`screen_batch`** and **`submit_screen`** (screen mode) split the quick idea screen so the Compliance agent itself judges the batch under [rules/idea-screen.md](../rules/idea-screen.md) and the app validates it. `screen_batch` returns `ready: false` (with the ping count) until the batch is ready, `already_screened` once the cycle is done, or a `screen_id` and one line per idea: the pending clusters with leads saved since the last finished screen, at most 20, highest `unserved_score` first. Each line carries the label, source, buyer type, first evidence line and revenue hypothesis, never contacts or names. `submit_screen` takes `{ screen_id, selected: [{pick, reason, experiment, risks}], excluded: [{pick, category, reason}] }`. It refuses with `invalid` and writes nothing unless every pick appears exactly once and at least 8 are selected (unless hard blockers leave fewer). Otherwise it approves the picks, rejects `obvious_illegal` and `clearly_unworkable` ones with a `decisions` row each, and leaves `lower_priority` ones pending. It then creates Creator's "Design" cards for the approved clusters while slots are free, and returns how many as `creator_cards`. If waking Creator fails, the verdicts stay committed and the sweep hands out the cards (it returns `creator_cards: 0`).

```jsonc
// screen_batch output
{ "ready": true, "screen_id": "sc_...", "candidates": 19,
  "ideas": [ "1. [consumer/reddit_x] Consumers asking for an app for meals ... | signal: ... | revenue: consumers pays $4 monthly for ..." ] }
// submit_screen output
{ "screen_id": "sc_...", "approved": 11, "rejected": 1, "kept_pending": 7, "shortfall": 0, "creator_cards": 3 }
```

**`list_pending`** returns offers and clusters waiting for review, oldest first (stable `created_at, id` order), up to `limit` of each: for an offer, every field; for a cluster, its label, source, stored `signal_count` and 3 sample leads (name and url). Offers come first, so a long queue of clusters can't push them out of view. Optional `after_cluster_id` and `after_offer_id` are independent cursors, returned as `next_cluster_id` and `next_offer_id` (null when exhausted). Snapshot pages before reviewing, deduplicate IDs, and retain an exhausted stream's last cursor while paging the other. Cursors survive earlier rows changing review status; concurrent additions may wait for the next pass.

```jsonc
// input
{ "limit": 3 }   // of each; at most 10
// output
{ "clusters": [ { "id": "cl_...", "label": "...", "source": "...", "signal_count": 3, "sample_leads": [ ... ] } ],
  "offers": [ { "id": "of_...", "cluster_id": "cl_...", "buyer": "...", "sample": "...", "product": "...",
                "price_cents": 9900, "channel": "contact_form", "outreach_message": "...",
                "follow_up_message": "...", "delivery": "..." } ],
  "next_cluster_id": null, "next_offer_id": null }
```

**`review_context`** is a read-only extension for Compliance. Creator reads it too, to write an offer from what Scout found on the leads. The queue preview does not contain Scout's evidence. Input `{ "cluster_id": "cl_...", "offer_id": "of_...", "leads_limit": 3, "after_lead_id": "ld_..." }` has optional offer/cursor and a 1–10 lead limit. It returns the cluster's current status/reason/count, the exact offer with current status (or null), saved leads with IDs, URLs, contact routes, external IDs, data, assignment and status, and `next_lead_id` (null when exhausted). The offer must belong to the given cluster. Leads sort by ID for stable pagination. Lower the limit on an oversized response; if one full lead cannot fit, report unavailable evidence and keep pending. This adds no state, migration, or second service. Native app permissions must explicitly allow `foundry.review_context`.

**`review`** approves or rejects one cluster or offer and writes an `approve` or `reject` decision.

```jsonc
// input
{ "target": "offer", "id": "of_...", "decision": "reject",
  "reason": "outreach message claims 'Google-certified', which we can't back up" }
// output
{ "id": "of_...", "review_status": "rejected" }
```

### Creator

**`list_offers`** lists offers, newest first, with their review result and the companies spawned from each. Creator remembers nothing between cards, so this is how it finds approved offers to spawn, avoids a second offer for a cluster while one is pending, and reads why an offer was rejected.

```jsonc
// input
{ "review_status": "approved", "cluster_id": null, "unspawned_only": true, "limit": 5 }   // limit at most 20
// output
{ "offers": [ { "id": "of_...", "cluster_id": "cl_...", "product": "...", "price_cents": 9900, "channel": "contact_form",
                "review_status": "approved", "review_reason": "...", "parent_offer_id": null, "created_at": "...",
                "companies": [ { "id": "co_...", "slug": "co-03", "status": "killed" } ] } ] }
```

**`propose_offer`** stores an offer for an approved cluster. Offers are approved on submission, so `spawn` can use it right away.

```jsonc
// input
{ "cluster_id": "cl_...", "buyer": "...", "sample": "...", "product": "...", "price_cents": 9900,
  "channel": "contact_form", "outreach_message": "Hi {{lead_name}}, ... {{sample_url}}",
  "follow_up_message": "...", "delivery": "...", "parent_offer_id": null }
// output
{ "offer_id": "of_...", "review_status": "approved" }
```

Refused with `not_approved` if the cluster isn't approved, and with `invalid` if `channel` isn't one we can run.

**`spawn`** opens a company from an approved offer. It writes rows only, in one transaction: the `companies` row (status `spawning`), the offer's cluster's oldest 5 leads that no company has (status `assigned`), and a `spawn` decision. It creates nothing in Naïve and no card. The number 5 is `SAMPLE_LEADS` in `src/lib/server/foundry/roles.ts`.

```jsonc
// input
{ "request_id": "of_...-1",   // any string unique to this decision; makes retries safe
  "offer_id": "of_...", "parent_id": null,
  "reason": "43 leads, approved, nobody serving the cluster" }
// output
{ "company_id": "co_...", "slug": "co-03", "status": "spawning", "lead_ids": ["ld_...", "ld_..."] }
```

Creator then calls `publish_sample` for each of `lead_ids`. When the last lead has a sample (or a logged `failed` touch), the company becomes `proposed`. Refused with `policy` when `max_proposed` companies are already waiting (`spawning` or `proposed`), with `invalid` when the cluster has no leads left, with `not_approved` for an offer that isn't approved, and with `conflict` when the `request_id` was used for another offer. A retry with the same `request_id` returns the same company and creates nothing.

### VC

**`reconcile`** is the sweep (section 4). VC calls it first on every pass. It takes no input and returns how many cards of each kind it created, or `stopped: true`.

```jsonc
// output
{ "stopped": false, "created": { "design": 1, "screen": 0, "contact": 0, "followUp": 0, "deliver": 0, "inbound": 0 } }
```

**`fund`** grants one grant to a proposed or active company. It records the grant on the company, writes a `fund` decision with the amount, and creates cards. It changes no agent budget: the grant is the company's spending limit (section 4). The first grant moves the company from `proposed` to `active` and creates an Outreach "Contact" card for each lead that has a sample and no `sent` touch. A second or third grant assigns the cluster's next 5 unassigned leads to the company and creates a Creator "Sample" card for them. Every grant creates a Feedback card. The cards are created inside the grant's transaction, so a card that fails rolls the grant back, and a retry finds the same cards by key.

```jsonc
// input
{ "company_id": "co_...", "reason": "43 leads, clear sample, contact forms on 38 of them" }
// output
{ "company_id": "co_...", "status": "active", "granted_micro_usd": 5000000,
  "pool_left_micro_usd": 5000000, "leads_added": 0, "work_created": 6 }
```

`granted_micro_usd` is the company's total so far. Refused with `policy` if the grant would exceed the pool, the company's grant count (`max_grants_per_company`), or `max_active` (on a first grant); with `killed` for a killed company; and with `conflict` for a company whose samples aren't all published yet (`spawning`) or that failed.

**`kill`** marks the company `killed`, writes a `kill` decision and closes the company's open cards, so the crew does no more work for it. It changes no agent budget. It creates a Feedback card, and a Creator "Revise" card if the company's cluster still has leads no company has. VC also uses it on a proposed company it declines, so the slot frees. Samples, leads and history stay, so the dashboard can still show what the company made. A buyer who already paid is still delivered. Unspent grant money doesn't return to the pool, because Naïve spends from org credits rather than from a grant.

```jsonc
// input
{ "company_id": "co_...", "reason": "40 touches, 0 replies, $4.10 spent" }
// output
{ "company_id": "co_...", "status": "killed", "cards_closed": 3 }
```

**`log_decision`** records a `hold`: Creator or VC reviewed and chose to do nothing.

```jsonc
// input
{ "agent": "vc", "kind": "hold", "company_id": null, "reason": "pool has $2 left; waiting for co-01's first reply" }
// output
{ "decision_id": "dc_..." }
```

### Reading results

**`get_metrics`**, with `company_id` for one company or without it for the whole foundry. Before answering, the app refreshes `spend` from Naïve if the last sync is more than 5 minutes old. The full sample is in section 7.

```jsonc
// input
{ "company_id": null, "companies_limit": 8, "decisions_limit": 5 }   // live companies first, then the newest
// output
{ "as_of": "...", "policy": { ... }, "totals": { ... }, "companies": [ ... ], "decisions": [ ... ] }
```

**`get_company`** returns one company in detail: its offer, its leads with their latest touches and payments (most recent activity first), and the crew's spend on it per agent (from the sessions charged to it). The dashboard uses it for the one-company deep dive, with larger limits, `include_data` for what Scout found on each lead, and `spend_history` for spend over time.

```jsonc
// input
{ "company_id": "co_...", "leads_limit": 4, "touches_per_lead": 3, "include_data": false, "spend_history": false }
// output
{ "company": { /* one entry of get_metrics.companies */ }, "offer": { /* every offer field */ },
  "leads": [ { "id": "ld_...", "name": "...", "status": "paid", "sample_url": "https://.../s/ld_...",
               "touches": [ { "channel": "contact_form", "kind": "sent", "at": "..." } ],
               "payments": [ { "amount_cents": 9900, "at": "..." } ] } ],
  "spend": [ { "agent_name": "outreach", "micro_usd": 2400000, "synced_at": "..." } ] }
```

### Lead and email tools

**`log_touch`** is called by Creator (for a `failed` sample), Outreach and the Closer.

```jsonc
// input
{ "company_id": "co_...", "lead_id": "ld_...", "agent_name": "outreach",
  "channel": "contact_form", "kind": "sent", "detail": "sample https://.../s/ld_...", "cost_micro_usd": 12000,
  "message_id": null }   // for reply_received: the inbound email's inb_ id
// output
{ "touch_id": "tc_...", "lead_status": "contacted" }
```

`sent` moves the lead to `contacted` and `reply_received` to `replied`. Status never moves backwards. A `sample_delivered` touch sets the lead's `sample_url` to `detail`. A `failed` touch on a spawning company can complete its samples and make it `proposed`. `message_id` records which inbound email the Closer answered, so the sweep doesn't hand the same email out again. A killed company still takes `reply_received`, `reply_sent` and `delivered` touches, because a buyer may pay after a kill; any other touch on a killed company returns `killed`.

**`find_lead`** finds a lead by `lead_id`, `email`, `url` or `name` (give at least one). `company_id` is optional. With it, the search covers only that company's leads. Without it, the search covers every live company, which is how the Closer finds who wrote to the shared inbox. Each lead says its `company_id` and `contact_url`, because a card title carries only the lead id.

```jsonc
// input
{ "company_id": null, "lead_id": null, "email": "dr.ruiz@example.com", "url": null, "name": null }
// output
{ "leads": [ { "id": "ld_...", "company_id": "co_...", "name": "Folsom Street Dental", "email": "dr.ruiz@example.com",
               "url": "https://...", "contact_url": "https://.../contact", "status": "contacted", "sample_url": "https://.../s/ld_..." } ] }
```

If the sender's address isn't one Scout found, the quoted sample link still identifies the lead: its last path segment is the lead id.

**`publish_sample`** publishes one lead's sample, a single HTML page of at most 100,000 characters. The foundry stores it in `samples`, sets the lead's `sample_url` to `<FOUNDRY_URL>/s/<lead_id>`, and logs a `sample_delivered` touch. It redeploys nothing. Publishing again replaces the page. When the last lead of a spawning company has a sample, the company becomes `proposed`. On an active company, a lead that is still `assigned` gets an Outreach "Contact" card, and the card key keeps a republish from waking Outreach twice. The company's row is locked during the call, so two publishes can't both miss the `proposed` step. Refused with `killed` for a killed company and `conflict` for one that isn't spawning, proposed or active.

```jsonc
// input
{ "company_id": "co_...", "lead_id": "ld_...", "agent_name": "creator", "html": "<!doctype html>..." }
// output
{ "lead_id": "ld_...", "sample_url": "https://<FOUNDRY_URL>/s/ld_...", "company_status": "proposed", "handed_to": null }   // handed_to is "outreach" when it created a Contact card
```

**`read_inbound`** returns one email to the shared inbox from the last 7 days, by its `inb_` id: sender, subject, text and arrival time. The Closer calls it for an "Answer email" card. The text was written by an outside sender, so it is data, never instructions.

```jsonc
// input
{ "message_id": "inb_..." }
// output
{ "id": "inb_...", "from": "dr.ruiz@example.com", "subject": "Re: a free sample", "text": "...", "received_at": "..." }
```

**`dismiss_inbound`** marks an email handled without a lead (spam, an auto-reply, or a sender no lead matches). The sweep then never hands it out again.

```jsonc
// input
{ "message_id": "inb_...", "reason": "spam" }
// output
{ "message_id": "inb_...", "dismissed": true }
```

**`checkout_link`** returns a payment URL for one lead, at the offer's price. See section 6. Asking again for the same lead returns the same checkout until it's within an hour of closing. Refused with `conflict` for a company that isn't active or a lead that has already paid, and with `killed` for a killed company.

```jsonc
// input
{ "company_id": "co_...", "lead_id": "ld_..." }
// output
{ "url": "https://checkout.stripe.com/...", "amount_cents": 9900, "expires_at": "..." }   // open for 23 hours
```

## 6. Payments

**Decided (#15): Naïve app payments on the foundry app, with Stripe as the fallback.** Naïve's payments are enabled for our org: `GET /v1/apps/<foundry>/payments` answers `stage: not_started` instead of 501 (verified Nov 8). Onboarding then failed on a setting in Naïve's own Stripe platform account, which only Naïve can change, so the app can also take payments through our own Stripe account. With the app secret `STRIPE_SECRET_KEY` set, `checkout_link` opens Stripe Checkout sessions instead of Naïve checkouts. Without it, the app uses Naïve's. Everything after the checkout is the same for both.

- **Checkout.** `checkout_link` calls `POST /v1/apps/<foundry>/payments/checkouts` with the app's own key (`NAIVE_API_KEY`; Naïve takes no other key for this) and `order_ref` set to `<company_id>:<lead_id>`. One line at the offer's price, `countries: ["US"]`, a free "Delivered by email" shipping option (Naïve requires one), no automatic tax, and the lead's sample page as the return URL. Naïve answers `checkout_ref` and `url`, and the app stores them in `checkouts`. The app needs its own id as the secret `FOUNDRY_APP_ID`.
- **Event.** For every checkout, refund or dispute event, Naïve posts `{ id, type, checkout_ref, order_ref, payment_ref }` to `/api/orders/events` with the app's MCP bearer (`VETTA_MCP_TOKEN`), and never acts on the body itself. The app ignores everything but `checkout_ref`. It finds the lead in `checkouts`, so a forged `order_ref` can't credit another lead, and reads the checkout back from Naïve for whether it's paid, `amount_cents`, `refunded_cents` and `livemode`.
- **Ledger.** A paid checkout writes one `payments` row with `source: naive_checkout` and `external_ref` set to the `checkout_ref`, so a replayed event changes nothing. A refund event updates `refunded_cents` on the same row. Events for a checkout the app didn't open, or one that isn't paid, are answered and ignored. A failure answers non-2xx and changes nothing a replay can't finish.
- **Stripe.** `checkout_link` creates a Checkout session (`mode: payment`, `managed_payments[enabled]: false`, one `price_data` line in USD) with `client_reference_id` and `metadata.order_ref` set to `<company_id>:<lead_id>`, and stores the session id as the checkout's `ref`. Without the opt-out, our Stripe sandbox refused the first live session (Nov 8) because the product had no tax code eligible for Managed Payments, Stripe's merchant-of-record mode. Stripe's eligibility rules exclude design and development services, so the app always opts out. Stripe posts events to `/api/stripe/webhook`, signed with the endpoint's secret (`STRIPE_WEBHOOK_SECRET`). The app refuses a bad or stale signature (older than five minutes) with 400. For `checkout.session.*` events it reads the session back, expanding `payment_intent.latest_charge`, for `payment_status`, `amount_total`, the charge's `amount_refunded` and `livemode`. A `charge.refunded` event names a charge, so the app finds the session by the charge's payment intent. The endpoint in Stripe sends `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `charge.refunded`. Payments rows get `source: stripe`. A failed Stripe call returns `naive_error` like a failed Naïve call, with the message naming the step.
- **Onboarding.** Only a signed-in owner or admin can start it, from the Studio; every API key is refused. It makes the account and answers a single-use link to Stripe's onboarding (`country`, default `US`). Until the account's `stage` is `ready` and `can_take_payments` is true, Naïve refuses checkouts and `checkout_link` returns `naive_error`.

Not documented, so the first real payment checks them: the name of the checkout's paid field (the app reads `paid`, then `payment_status`, then `status`, and fails naming the fields it got otherwise), whether `expires_at` is in seconds (the app sends Unix seconds, 23 hours out), whether Naïve retries an event the app didn't accept, and the fee Naïve takes.

When a payment lands, the app sets the lead's status to `paid` and creates a "Deliver" card on the Closer's board: title `Deliver <lead_id> for <company_id>`, key `closer:deliver:<lead_id>`. Assigning the card wakes the Closer to deliver the product. It also creates a Creator card, `Consider a sibling of <company_id>`, with the key `creator:sibling:<company_id>`, so a company's first payment can lead to a sibling. The payment is committed before the cards are made, so a failed card loses nothing and the next delivery of the event makes it. A payment that lands after a kill is still recorded and delivered, paid for from the Closer's own budget rather than the dead company's grant. While the company is stopped, the payment is recorded and the sweep creates the Deliver card after Launch.

**No agent writes a payment.** Payments come only from the payment provider, so an agent can't report revenue that didn't happen.

## 7. Sample `get_metrics` response

The dashboard (#14) builds against this until #10 serves the real thing. All numbers are made up.

```json
{
  "as_of": "2026-11-08T08:00:00Z",
  "policy": {
    "pool_micro_usd": 10000000, "granted_micro_usd": 10000000, "pool_left_micro_usd": 0,
    "grant_micro_usd": 5000000, "max_proposed": 3, "max_active": 2
  },
  "totals": {
    "clusters": 6, "clusters_approved": 4, "offers": 3, "offers_approved": 3,
    "companies_proposed": 1, "companies_active": 1, "companies_killed": 1,
    "leads": 128, "touches": 102, "replies": 7, "payments": 2,
    "spend_micro_usd": 8640000, "revenue_cents": 19800
  },
  "companies": [
    {
      "id": "co_01", "slug": "co-01", "status": "active", "offer_id": "of_01", "cluster_id": "cl_01",
      "parent_id": null, "offer_summary": "One-page site rebuild for SF dentists, $99",
      "spawned_at": "2026-11-07T23:10:00Z", "funded_at": "2026-11-07T23:30:00Z", "killed_at": null,
      "granted_micro_usd": 5000000, "spend_micro_usd": 4540000, "revenue_cents": 19800,
      "funnel": { "leads": 10, "sampled": 10, "contacted": 9, "replied": 6, "paid": 2 },
      "touches_by_channel": { "contact_form": 9, "email": 7 },
      "cost_per_reply_micro_usd": 756666
    },
    {
      "id": "co_02", "slug": "co-02", "status": "killed", "offer_id": "of_02", "cluster_id": "cl_02",
      "parent_id": null, "offer_summary": "Accessibility audit for small Shopify stores, $79",
      "spawned_at": "2026-11-07T23:40:00Z", "funded_at": "2026-11-08T00:05:00Z", "killed_at": "2026-11-08T06:00:00Z",
      "granted_micro_usd": 5000000, "spend_micro_usd": 4100000, "revenue_cents": 0,
      "funnel": { "leads": 10, "sampled": 10, "contacted": 10, "replied": 1, "paid": 0 },
      "touches_by_channel": { "contact_form": 10, "email": 8 },
      "cost_per_reply_micro_usd": 4100000
    },
    {
      "id": "co_03", "slug": "co-03", "status": "proposed", "offer_id": "of_03", "cluster_id": "cl_04",
      "parent_id": "co_01", "offer_summary": "One-page site rebuild for Oakland bakeries, $99",
      "spawned_at": "2026-11-08T07:00:00Z", "funded_at": null, "killed_at": null,
      "granted_micro_usd": 0, "spend_micro_usd": 0, "revenue_cents": 0,
      "funnel": { "leads": 10, "sampled": 0, "contacted": 0, "replied": 0, "paid": 0 },
      "touches_by_channel": {},
      "cost_per_reply_micro_usd": null
    }
  ],
  "decisions": [
    { "id": "dc_07", "agent": "vc", "kind": "hold", "company_id": "co_03",
      "reason": "pool is empty; co-03 waits until we raise it", "at": "2026-11-08T08:00:00Z" },
    { "id": "dc_06", "agent": "creator", "kind": "spawn", "company_id": "co_03",
      "reason": "co-01's offer converts; same offer, new city", "at": "2026-11-08T07:00:00Z" },
    { "id": "dc_05", "agent": "vc", "kind": "kill", "company_id": "co_02",
      "reason": "10 contacted, 1 reply, $4.10 spent", "at": "2026-11-08T06:00:00Z" },
    { "id": "dc_04", "agent": "compliance", "kind": "reject", "cluster_id": "cl_05",
      "reason": "requires physical delivery that our agents cannot fulfill", "at": "2026-11-08T03:12:00Z" }
  ]
}
```

The sample shows the fields as they are now. `spend_micro_usd` is the sum of the crew sessions charged to the company (`session_spend`, section 4), not the spend of agents it owns, and a company with `granted_micro_usd` 0 has spent 0. `funnel.sampled` counts leads with a `sample_url`. The `companies` list includes killed and proposed companies, so the lineage tree can show them. `cost_per_reply_micro_usd` is `null` when a company has no replies.

Revenue, `totals.payments` and the funnel's `paid` stage count live payments only (`livemode` true). A test-mode payment, such as a Stripe test card, proves the flow but moves no money. It stays on its lead in `get_company` with `livemode: false`, and the dashboard marks it as test mode. A lead paid only in test mode still counts as replied.

## 8. The cost experiment

Before VC runs on its own, we measure what a company costs.

1. Fund one or two companies under the placeholder policy ($5 grants, $10 pool).
2. Let them run for a few hours.
3. From `session_spend`, read the cost per lead (sample plus outreach), and the cost of the Closer's sessions with no company.
4. Set the real `funding_policy`: grant size, pool, and how many companies run at once.

The only change after the experiment is that one row. No code changes.

## 9. Open questions

These don't block approval; the owning issue settles each one.

1. Does a Naïve MCP call carry anything that identifies the calling agent? If it does, the app can check permissions itself instead of trusting the caller's name. (#10)
2. ~~Does a fullstack Naïve app run our Next.js starter?~~ **Yes (#10).** A fullstack app is a Next.js project that Naïve builds on Vercel, with `DATABASE_URL` injected. The foundry is live at `https://foundry-p2jr2103s9ve.vercel.app`, with tools at `/mcp`.
3. ~~Do the app's own Naïve key scopes cover spawn, fund, kill, board cards and spend reads?~~ **Only spend reads (#10),** so the app holds an org key instead. See section 5.
4. ~~Can an agent be created with a zero budget cap?~~ **Yes (#16),** if `max_task_micro_usd` is 0 too. Naïve refuses a zero cap with a nonzero task cap.
5. ~~Are Naïve store payments enabled for our org, or do they answer 501?~~ **Enabled (#15).** The foundry app's payments answer `stage: not_started` until the owner onboards.
6. Can the dashboard be served by the foundry app itself, or does it need its own app? (#10, #14)
7. ~~Does `spawn` finish inside the foundry app's function time limit?~~ **Moot.** `spawn` writes rows only and makes no Naïve call.

## 10. Calls made while drafting

Claude made these calls to close gaps in the design. Check them before approving.

- Seven fixed shared agents replace the four fixed templates and the per-company crew of a first draft, and offers carry what used to differ between templates. A company is rows, not agents.
- Compliance screens clusters only. Offers are approved on submission (owner policy, Nov 8).
- `spawn` picks the leads itself, the oldest unassigned ones in the cluster.
- Outreach sends only the offer's two messages, word for word, with the lead's name and sample URL filled in.
- A grant is a spending limit on the company's crew sessions, not a set of agent budgets.
- Killing a company doesn't return unspent grant money to the pool.
- When a payment lands, the app marks the lead paid and wakes the Closer with a "Deliver" card, even after a kill or while the company is stopped.
- Agents can't record payments; only the payment provider's event can.
- `spend` keeps a snapshot per sync, so the dashboard can chart spend over time.
