# Foundry contract

Status: **draft for #8**. Felix and Mateo both approve it before anyone builds against it. Change it through a PR that both of us review.

The foundry is the fullstack Naïve app that every other piece talks to. Agents call its MCP tools, the dashboard reads its metrics, and spawning, funding and killing run through it. This document fixes what both sides depend on: who decides what, the tables, the tools, the generic child crew, and the payment path. Anything not written here is left to whoever owns the issue.

Where this contract and [the build doc](AUTO_FOUNDRY_BUILD.md) disagree, this contract wins. It replaces the build doc's single CEO and its four fixed templates (section 1). Facts marked **(verified)** were checked against our org on Nov 7; see section 0 of the build doc.

## 1. Who decides what

One parent, the foundry, runs four agents. No person approves anything after the rules file is written.

```text
Scout ──▶ Compliance ──▶ Creator ──▶ Compliance ──▶ Funder
finds      approves or    writes an    approves or    funds, adds to,
demand     rejects the    offer and    rejects the    or kills each
           cluster        spawns the   offer          company
                          company
                          unfunded
```

1. **Scout** finds demand and writes clusters and leads. It never contacts anyone.
2. **Compliance** reviews each new cluster against the rules file and produces a ranked shortlist targeting **8–12 company candidates**. Is the buyer's need supported by evidence, and can agents serve it end to end? B2B, B2C and B2A clusters are all eligible. Rejected clusters stop here.
3. **Creator** works from the approved shortlist, picks a cluster nobody serves, writes an **offer** for it (section 4), and submits it.
4. **Compliance** reviews the offer: the outreach message, the sample, the price, the claims.
5. **Creator** spawns a company from the approved offer. Its agents, inbox and app exist, but every budget is **zero**, so nothing runs. Status: `proposed`.
6. **Funder** reviews proposed companies. Its first grant rests on the offer and the cluster's evidence, since there are no results yet. Funding sets the agents' budgets and the company starts. Status: `active`.
7. **Funder** keeps watching results, grants more to companies that convert, and kills the ones that don't by setting their budgets back to zero.

Every one of these decisions is written to `decisions` with a one-line reason. The dashboard shows them as one log.

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

### Compliance's company shortlist

For each incoming Scout candidate batch, Compliance's deliverable is a ranked shortlist targeting **8–12 distinct company opportunities**. Each recommendation represents a buyer/problem cluster with its supporting leads; multiple leads for the same opportunity do not count as multiple companies. There is no required mix of B2B, B2C and B2A candidates.

Each entry identifies its source `cluster_id`, buyer and buyer type, the evidenced need, supporting source links, verified lead count, feasible digital delivery path, and a concise selection reason. Rank eligible candidates by evidence strength and delivery/channel readiness. Report unresolved evidence gaps separately. A valid candidate outside the top 12 is eligible backlog, not a policy rejection.

The count is a target, not permission to invent candidates or weaken review rules. If fewer than eight qualify, return the qualified shortlist, state the shortfall, and identify what additional research is needed. Incomplete evidence stays pending; clear rule violations are rejected with a reason. The existing review API still records individual approve/reject decisions; the shortlist and research gaps are the agent's review report, not a new database status or MCP tool.

Creator turns shortlisted opportunities into concrete offers. Compliance then reviews those offers. Mark an entry **ready for spawn** only when its offer has been approved, and include the approved `offer_id` in that handoff. Compliance recommends and reviews; Creator calls `spawn`, and Funder decides which proposed companies receive money.

An 8–12-entry shortlist does not raise the funding pool or concurrency limits below. Candidates wait in the approved backlog and are spawned/funded as policy capacity permits.

### Funding policy

Funder's limits live in one database row, `funding_policy` (section 2), and `fund` refuses anything outside them. We set the real numbers after the cost experiment (section 8). Until then: $5 per grant, $10 in total, at most 3 proposed companies waiting and 2 active at once. These placeholders are Claude's call, made while drafting.

## 2. Conventions

- **Ids.** Foundry rows use text ids with a prefix: `cl_` clusters, `of_` offers, `co_` companies, `ld_` leads, `tc_` touches, `py_` payments, `dc_` decisions. Companies also get a short slug: `co-01`, `co-02`, in spawn order.
- **Naïve ids** (`agt_`, `idn_`, `app_`, `eml_`) are stored as given and never parsed.
- **Money.** Costs, budgets and grants are integer micro-dollars (`*_micro_usd`), the unit Naïve's API uses (verified: it rejects `cap_usd`). Payments are integer cents (`*_cents`), the unit Stripe and Naïve app payments use. No field mixes the two.
- **Time.** `timestamptz`, UTC. Tools return ISO 8601 strings.
- **Agent names.** The parent's agents are `scout`, `compliance`, `creator` and `funder`. A child's agents are `<slug>-<role>`, for example `co-01-builder`. Board cards are assigned by agent **name**, so names must be unique in the org.

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
  sample             text not null,                 -- what Builder makes for free: "a rebuilt one-page site"
  product            text not null,                 -- what they pay for: "that site on your domain, plus 30 days of edits"
  price_cents        integer not null,
  channel            text not null,                 -- contact_form | email | x_reply
  outreach_message   text not null,                 -- the exact first message, with {{lead_name}} and {{sample_url}}
  follow_up_message  text,                          -- one follow-up, or null
  delivery           text not null,                 -- how the paid product reaches them, by email or link
  review_status      text not null default 'pending', -- pending | approved | rejected
  review_reason      text,
  parent_offer_id    text references offers(id),    -- set when Creator revises a killed company's offer
  created_at         timestamptz not null default now()
);

create table companies (
  id                 text primary key,              -- co_...
  slug               text not null unique,          -- co-01
  offer_id           text not null references offers(id),
  cluster_id         text not null references clusters(id),
  parent_id          text references companies(id), -- sibling of a company that converted; null otherwise
  status             text not null default 'spawning', -- spawning | proposed | active | killed | failed
  granted_micro_usd  bigint not null default 0,     -- total Funder has granted
  spawned_at         timestamptz not null default now(),
  funded_at          timestamptz,
  killed_at          timestamptz
);

-- Every Naïve resource spawn created for a company. fund and kill read it; spawn retries use it to avoid duplicates.
create table company_resources (
  company_id   text not null references companies(id),
  kind         text not null,                       -- agent | identity | inbox | app | card
  role         text,                                -- builder | outreach | closer (agents only)
  naive_id     text not null,
  name         text,                                -- agent name, inbox address, app URL
  created_at   timestamptz not null default now(),
  primary key (company_id, kind, naive_id)
);

create table leads (
  id           text primary key,                    -- ld_...
  cluster_id   text not null references clusters(id),
  company_id   text references companies(id),       -- set when a spawn picks the lead up
  name         text not null,                       -- buyer name (business, individual or agent)
  url          text,                                -- their current site, store or listing
  contact_url  text,                                -- contact form page, if found
  email        text,
  external_id  text,                                -- Google place_id, X post id, ...; used to skip duplicates
  status       text not null default 'new',         -- new | assigned | contacted | replied | paid | dead
  sample_url   text,                                -- the free sample built for them; ends in /<lead id>
  data         jsonb not null default '{}',         -- whatever Scout found: rating, screenshot file id, issues
  created_at   timestamptz not null default now(),
  unique (cluster_id, external_id)
);

create table touches (
  id              text primary key,                 -- tc_...
  company_id      text not null references companies(id),
  lead_id         text references leads(id),
  agent_name      text not null,                    -- co-01-outreach
  channel         text not null,                    -- contact_form | email | x_reply
  kind            text not null,                    -- sample_delivered | sent | failed | reply_received | reply_sent | delivered
  detail          text,                             -- one line: the failure reason, the sample URL, ...
  cost_micro_usd  bigint not null default 0,
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

-- Spend per agent, copied from Naïve. Agents never report their own spend.
-- Each sync appends a row, so the dashboard can chart spend over time; the latest row per agent is current.
create table spend (
  company_id   text references companies(id),       -- null for the parent's agents
  agent_id     text not null,
  agent_name   text not null,
  micro_usd    bigint not null,                     -- total spend so far, as Naïve reports it
  synced_at    timestamptz not null default now(),
  primary key (agent_id, synced_at)
);

-- Every decision by Compliance, Creator and Funder, including choosing to do nothing.
create table decisions (
  id                text primary key,               -- dc_...
  agent             text not null,                  -- compliance | creator | funder
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
  pool_micro_usd         bigint not null,           -- total Funder may grant, ever
  grant_micro_usd        bigint not null,           -- size of one grant
  max_grants_per_company integer not null,
  max_proposed           integer not null,          -- unfunded companies waiting at once
  max_active             integer not null,
  budget_split           jsonb not null,            -- share of a grant per role
  updated_at             timestamptz not null default now()
);

insert into funding_policy values
  (1, 10000000, 5000000, 3, 3, 2, '{"builder": 0.5, "outreach": 0.3, "closer": 0.2}', now());
```

## 4. The generic child crew

Every child has the same three roles. What differs is the offer, which `spawn` fills into the prompts.

- **Builder** gets one board card per lead, builds the free sample described in `{{sample}}`, deploys it in the child's app at `{{app_url}}/<lead_id>`, and logs a `sample_delivered` touch with that URL. Then it hands the lead to Outreach with a card.
- **Outreach** sends `{{outreach_message}}` through `{{channel}}`, with the lead's name and sample URL filled in, and sends `{{follow_up_message}}` once, 20 hours later, if there's no reply. It sends no other text. It logs each touch, including failures.
- **Closer** owns the inbox and wakes on replies. It answers questions, sends a checkout link from `checkout_link`, and delivers `{{product}}` as `{{delivery}}` describes when the app wakes it with a "Deliver" card after payment.

The crew lives in one folder, owned by #12:

```text
templates/child/
  agents/builder.agent.yaml
  agents/outreach.agent.yaml
  agents/closer.agent.yaml
  prompts/builder.md
  prompts/outreach.md
  prompts/closer.md
```

`spawn` fills these placeholders in every file, and nothing else:

| Placeholder | Source |
|---|---|
| `{{company_id}}`, `{{slug}}` | the new company |
| `{{inbox}}` | the company's inbox, e.g. `co-03@auto-foundry-03s9ve.usenaive.ai` |
| `{{app_id}}`, `{{app_url}}` | the child's `frontend_only` app |
| `{{buyer}}`, `{{sample}}`, `{{product}}`, `{{price}}`, `{{channel}}`, `{{delivery}}` | the offer; `{{price}}` is formatted, e.g. `$99` |
| `{{outreach_message}}`, `{{follow_up_message}}` | the offer, word for word |

`{{lead_name}}` and `{{sample_url}}` are not filled by `spawn`. They stay in the messages for Outreach to fill per lead.

Every agent config sets `default_config: { permission: deny }`. Child agents allow `foundry.log_touch`, `foundry.find_lead`, `foundry.get_company` and `foundry.get_metrics`; the Closer also allows `foundry.checkout_link`. The `apps` tool's `allowed_apps` lists the foundry app and the child's own app. Budgets in the files are 0; `fund` sets them.

A Builder card's `title` is the lead's name, and its `body` is the lead as JSON (`lead_id`, `name`, `url`, `contact_url`, `email`, `data`).

## 5. MCP tools

The app serves them at `/mcp` and rejects any call whose `Authorization: Bearer` is not `VETTA_MCP_TOKEN`. Agents see them as `foundry.<tool>`.

The platform injects the same token for every agent, so **the app can't tell which agent called**. Access is set on each agent's config instead: Naïve's docs say app tools are "gated by the same `default_config` + `configs` allow/ask/deny as every other tool", so permissions are per tool. Each agent allows only its own tools from this table. Tools that write take the caller's name so the record shows who did it.

| Tool | Who may call it | Owner |
|---|---|---|
| `add_leads` | Scout | #10 |
| `list_clusters` | Scout, Compliance, Creator, Funder | #10 |
| `list_pending` | Compliance | #10 |
| `review` | Compliance | #10 |
| `propose_offer` | Creator | #10 |
| `spawn` | Creator | #16 |
| `fund` | Funder | #16 |
| `kill` | Funder | #16 |
| `log_decision` | Creator, Funder | #10 |
| `get_metrics` | Creator, Funder, child agents, dashboard | #10 |
| `get_company` | Creator, Funder, child agents, dashboard | #10 |
| `log_touch` | child agents | #10 |
| `find_lead` | child agents | #10 |
| `checkout_link` | Closer | #15 |

`spawn`, `fund`, `kill`, the spend sync and the payment handler call the Naïve API from the app's server code. Naïve gives each app its own key, approved by the owner, through `naive(env)` in `@usenaive-sdk/app`. #10 must check with `naive app permissions` that the key covers agents, identities, inboxes, apps, boards and spend reads. If it doesn't, the owner stores an org API key as an app secret instead.

Every tool returns JSON. A failure returns `{ "error": { "code": "...", "message": "..." } }` with MCP's `isError: true`. Codes: `not_found`, `invalid`, `conflict`, `not_approved` (the cluster or offer hasn't passed Compliance), `policy` (the funding policy refuses it; the message says which limit), `killed`, `naive_error` (a Naïve call failed; the message says which).

Keep responses under 8,000 characters, where Naïve cuts tool results. Tools that list take a `limit`, default 20.

### Scout

**`add_leads`** upserts the cluster by `label`, inserts leads, skips leads whose `(cluster, external_id)` already exists, and updates `signal_count`. A new cluster starts `pending` review.

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
{ "review_status": "approved", "unserved_only": true, "min_signal_count": 0, "limit": 20 }
// output
{ "clusters": [ { "id": "cl_...", "label": "...", "source": "google_maps", "signal_count": 43,
                  "unserved_score": 0.8, "review_status": "approved", "company_ids": [] } ] }
```

### Compliance

**`list_pending`** returns clusters and offers waiting for review, oldest first, with what Compliance needs to judge them: for a cluster, its label, source and 3 sample leads; for an offer, every field.

```jsonc
// input
{ "limit": 10 }
// output
{ "clusters": [ { "id": "cl_...", "label": "...", "source": "...", "sample_leads": [ ... ] } ],
  "offers": [ { "id": "of_...", "cluster_id": "cl_...", "buyer": "...", "sample": "...", "product": "...",
                "price_cents": 9900, "channel": "contact_form", "outreach_message": "...",
                "follow_up_message": "...", "delivery": "..." } ] }
```

**`review`** approves or rejects one cluster or offer and writes an `approve` or `reject` decision.

```jsonc
// input
{ "target": "offer", "id": "of_...", "decision": "reject",
  "reason": "outreach message claims 'Google-certified', which we can't back up" }
// output
{ "id": "of_...", "review_status": "rejected" }
```

### Creator

**`propose_offer`** stores an offer for an approved cluster. It starts `pending` until Compliance reviews it.

```jsonc
// input
{ "cluster_id": "cl_...", "buyer": "...", "sample": "...", "product": "...", "price_cents": 9900,
  "channel": "contact_form", "outreach_message": "Hi {{lead_name}}, I'm an AI agent ... {{sample_url}}",
  "follow_up_message": "...", "delivery": "...", "parent_offer_id": null }
// output
{ "offer_id": "of_...", "review_status": "pending" }
```

Refused with `not_approved` if the cluster isn't approved, and with `invalid` if `channel` isn't one we can run.

**`spawn`** creates a company from an approved offer, in this order: the `companies` row, the identity and inbox, the three agents from `templates/child/` with zero budgets, the child's app, then one board card per lead assigned to the Builder. Each Naïve resource goes into `company_resources` as soon as it exists, so a retry with the same `request_id` resumes instead of creating duplicates.

`spawn` picks the leads itself: the oldest `lead_count` leads in the offer's cluster that no company has yet. It sets their `company_id` and status `assigned`. The cards wait: a Builder with no budget can't run until Funder funds the company.

```jsonc
// input
{ "request_id": "creator-2026-11-08T08:00-1",   // any string unique to this decision; makes retries safe
  "offer_id": "of_...", "lead_count": 10, "parent_id": null,
  "reason": "43 leads, approved, nobody serving the cluster" }
// output
{ "company_id": "co_...", "slug": "co-03", "status": "proposed",
  "agents": ["co-03-builder", "co-03-outreach", "co-03-closer"], "cards": 10 }
```

Writes a `spawn` decision. Refused with `policy` when `max_proposed` companies are already waiting. If a step fails, the company is `failed`, the output names the step, and a retry with the same `request_id` resumes it.

### Funder

**`fund`** grants one grant to a company. It splits the grant across the company's agents by `budget_split` and raises each agent's budget cap by its share with `agents_patch`. The first grant moves the company from `proposed` to `active`. Budgets use Naïve's `month` period, so a cap acts as the weekend's total.

```jsonc
// input
{ "company_id": "co_...", "reason": "43 leads, clear sample, contact forms on 38 of them" }
// output
{ "company_id": "co_...", "status": "active", "granted_micro_usd": 5000000,
  "pool_left_micro_usd": 5000000,
  "agents": [ { "name": "co-03-builder", "cap_micro_usd": 2500000 } ] }
```

Refused with `policy` if the grant would exceed the pool, the company's grant count, or `max_active`. Writes a `fund` decision with the amount.

**`kill`** sets every one of the company's agents to a zero budget with `agents_patch` (verified), marks the company `killed`, and writes a `kill` decision. Resources stay, so the dashboard can still show what the company made. Unspent grant money doesn't return to the pool, because Naïve spends from org credits rather than from a grant.

```jsonc
// input
{ "company_id": "co_...", "reason": "40 touches, 0 replies, $4.10 spent" }
// output
{ "company_id": "co_...", "status": "killed", "agents_stopped": 3 }
```

**`log_decision`** records a `hold`: Creator or Funder reviewed and chose to do nothing.

```jsonc
// input
{ "agent": "funder", "kind": "hold", "company_id": null, "reason": "pool has $2 left; waiting for co-01's first reply" }
// output
{ "decision_id": "dc_..." }
```

### Reading results

**`get_metrics`**, with `company_id` for one company or without it for the whole foundry. Before answering, the app refreshes `spend` from Naïve if the last sync is more than 5 minutes old. The full sample is in section 7.

```jsonc
// input
{ "company_id": null, "decisions_limit": 20 }
// output
{ "as_of": "...", "policy": { ... }, "totals": { ... }, "companies": [ ... ], "decisions": [ ... ] }
```

**`get_company`** returns one company in detail: its offer, its leads with their touches and payments (most recent activity first), and its spend snapshots. The dashboard uses it for the one-company deep dive.

```jsonc
// input
{ "company_id": "co_...", "leads_limit": 20 }
// output
{ "company": { /* one entry of get_metrics.companies */ }, "offer": { /* every offer field */ },
  "leads": [ { "id": "ld_...", "name": "...", "status": "paid", "sample_url": "https://.../ld_...",
               "touches": [ { "channel": "contact_form", "kind": "sent", "at": "..." } ],
               "payments": [ { "amount_cents": 9900, "at": "..." } ] } ],
  "spend": [ { "agent_name": "co-03-builder", "micro_usd": 2400000, "synced_at": "..." } ] }
```

### Child agents

**`log_touch`**

```jsonc
// input
{ "company_id": "co_...", "lead_id": "ld_...", "agent_name": "co-01-outreach",
  "channel": "contact_form", "kind": "sent", "detail": "sample https://.../ld_...", "cost_micro_usd": 12000 }
// output
{ "touch_id": "tc_...", "lead_status": "contacted" }
```

`sent` moves the lead to `contacted` and `reply_received` to `replied`. Status never moves backwards. A `sample_delivered` touch sets the lead's `sample_url` to `detail`. A touch on a killed company returns `killed`.

**`find_lead`** is how the Closer, woken by an inbound email, finds which lead wrote. It searches only the given company's leads.

```jsonc
// input
{ "company_id": "co_...", "email": "dr.ruiz@example.com", "url": null, "name": null }
// output
{ "leads": [ { "id": "ld_...", "name": "Folsom Street Dental", "status": "contacted", "sample_url": "https://.../ld_..." } ] }
```

If the sender's address isn't one Scout found, the quoted sample link still identifies the lead: its last path segment is the lead id.

**`checkout_link`** returns a payment URL for one lead, at the offer's price. See section 6.

```jsonc
// input
{ "company_id": "co_...", "lead_id": "ld_..." }
// output
{ "url": "https://checkout.stripe.com/...", "amount_cents": 9900, "expires_at": "..." }
```

## 6. Payments

The first choice is Naïve app payments on the foundry app; #15 decides.

- **Naïve checkout.** `checkout_link` opens a checkout on the foundry app with `order_ref` set to `<company_id>:<lead_id>`. When it's paid, Naïve posts the event to the foundry app's `/api/orders/events` with `VETTA_MCP_TOKEN`. The app reads the checkout back from Naïve and writes the `payments` row with `external_ref` set to the `checkout_ref`, so a replayed event changes nothing. This needs payments onboarding, which only the org owner can start from the dashboard. It may answer 501 if Naïve hasn't enabled store payments for us.
- **Fallback: Stripe.** One Stripe Payment Link per offer, with `client_reference_id` set to `<company_id>:<lead_id>`, and a webhook at `/api/stripe/webhook` that writes the same `payments` row with `source: stripe`.

When a payment lands, the app sets the lead's status to `paid` and creates a board card assigned to the company's Closer: title "Deliver: <lead name>", body the lead JSON plus the payment. Assigning the card wakes the Closer to deliver the product.

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
    { "id": "dc_07", "agent": "funder", "kind": "hold", "company_id": "co_03",
      "reason": "pool is empty; co-03 waits until we raise it", "at": "2026-11-08T08:00:00Z" },
    { "id": "dc_06", "agent": "creator", "kind": "spawn", "company_id": "co_03",
      "reason": "co-01's offer converts; same offer, new city", "at": "2026-11-08T07:00:00Z" },
    { "id": "dc_05", "agent": "funder", "kind": "kill", "company_id": "co_02",
      "reason": "10 contacted, 1 reply, $4.10 spent", "at": "2026-11-08T06:00:00Z" },
    { "id": "dc_04", "agent": "compliance", "kind": "reject", "cluster_id": "cl_05",
      "reason": "requires physical delivery that our agents cannot fulfill", "at": "2026-11-08T03:12:00Z" }
  ]
}
```

The `companies` list includes killed and proposed companies, so the lineage tree can show them. `cost_per_reply_micro_usd` is `null` when a company has no replies.

## 8. The cost experiment

Before Funder runs on its own, we measure what a company costs.

1. Fund one or two companies under the placeholder policy ($5 grants, $10 pool).
2. Let them run for a few hours.
3. From `spend`, read the cost per lead (sample plus outreach) and the cost per hour of an idle Closer.
4. Set the real `funding_policy`: grant size, pool, and how many companies run at once.

The only change after the experiment is that one row. No code changes.

## 9. Open questions

These don't block approval; the owning issue settles each one.

1. Does a Naïve MCP call carry anything that identifies the calling agent? If it does, the app can check permissions itself instead of trusting the caller's name. (#10)
2. Does a fullstack Naïve app run our Next.js starter, or do we serve `/mcp` and the dashboard from plain Node? (#10)
3. Do the app's own Naïve key scopes cover spawn, fund, kill, board cards and spend reads? (#10)
4. Can an agent be created with a zero budget cap, or does `spawn` create it with a tiny cap and patch it to zero? (#16)
5. Are Naïve store payments enabled for our org, or do they answer 501? (#15)
6. Can the dashboard be served by the foundry app itself, or does it need its own app? (#10, #14)

## 10. Calls made while drafting

Claude made these calls to close gaps in the design. Check them before approving.

- One generic three-role child crew replaces the four fixed templates, and offers carry what used to differ between templates.
- Compliance reviews twice: the cluster before Creator builds on it, and the offer before anyone funds it.
- `spawn` picks the leads itself, the oldest unassigned ones in the cluster.
- Outreach sends only the offer's approved messages, so nothing reaches a business that Compliance hasn't approved.
- A grant is split 50% Builder, 30% Outreach, 20% Closer.
- Killing a company doesn't return unspent grant money to the pool.
- When a payment lands, the app marks the lead paid and wakes the Closer with a "Deliver" card.
- Agents can't record payments; only the payment provider's event can.
- `spend` keeps a snapshot per sync, so the dashboard can chart spend over time.
