# Compliance

Compliance implements the two review gates in the [contract](foundry-contract.md). Scout remains owned by Claude. The agent reads Foundry's saved evidence, screens legal risk and monetization, reviews clusters/offers, and recommends up to 12 distinct company opportunities. It never contacts buyers, spawns companies, funds them, or changes budgets.

Files: [configuration](../agents/compliance.agent.yaml), [prompt](../agents/prompts/compliance.md), [owner rules](../rules/compliance.md), [report schema and handoff gate](../scripts/compliance-policy.ts), and [CLI](../scripts/compliance.ts).

## Review output

Every assessment includes buyer/type, evidenced need, source links, distinct verified lead IDs, feasible digital delivery, legal status/jurisdictions/primary-source basis/risks, and monetization status/payer/value/USD-cent price range/conservative cost/assumptions/pricing evidence/payment readiness. Economics are hypotheses until supported by actual outcomes; no estimated figure is reported as revenue.

Legal status is `clear`, `blocked` or `needs_review`; monetization is `plausible`, `unviable` or `needs_evidence`. Incomplete research stays pending with an actionable gap. Rules are scoped to the actual activity and jurisdiction; the agent's screening does not substitute for an expert determination when one is needed. Buyer types use identical gates. A consumer or agent buyer is never itself a rejection reason. Appointment booking, failed fetches, and inferred technical issues do not establish contactability or demand.

The collector validates the structured output and derives a ranked shortlist from successful Foundry tool-event receipts. It caps at 12 distinct clusters, retains eligible backlog and reports `shortfall = max(0, 8 - qualified_count)`. Rank by evidence, readiness and verified lead count. One strong buyer can be a valid single-lead opportunity; claiming recurrence across three buyers requires three independent observations. A cluster is `needs_offer`. `ready_for_spawn` requires an approved concrete offer ID, approved cluster receipts and verified payment readiness. Funding/concurrency limits still apply separately.

Each pass is instructed to inspect at most 20 clusters/30 targets, 30 context reads, six web searches and ten web fetches. Read-call limits are prompt requirements checked against actual events on collection; an overrun prevents enabling cron from that validation. Naïve enforces the 300,000 micro-USD ($0.30) run budget, 3,000,000 micro-USD ($3) daily cap and 500,000 micro-USD task maximum; metered tools may settle later. GLM is the already verified tool-calling model in this org; this configuration does not claim it is cheapest.

## Local checks and deployment

Use Node 24 and `pnpm install --frozen-lockfile`. Credentials come from ignored `.env.local` or the existing Naïve CLI login. Never paste them into prompts or artifacts. This CLI projects the API micro-USD config and runtime output schema; do not apply this YAML through CLI 1.0.3's USD file parser.

```sh
pnpm compliance check
pnpm check
pnpm compliance apply --mode audit
pnpm compliance run --request-id compliance-audit-001
pnpm compliance status --session ses_ID
pnpm compliance collect --session ses_ID
pnpm compliance deploy                     # creates/updates a PAUSED cron
```

The default native app is the verified Foundry app `app_f27yeve1gzgmztexhf9d0wbx62`; an override must resolve to an app named `foundry` with MCP `/mcp`. Permissions default deny: scoped read-only app access, `foundry.list_pending`, `foundry.list_clusters`, `foundry.review_context`, and read-only web tools. Audit omits `foundry.review`. Enforce adds only that write tool. MCP permissions are explicit `allow`, avoiding the native default `ask`. There are no contacts, browser, data-run, email, social, legal-formation, provisioning or funding tools.

`apply` checks org/agent ownership, paginates agent discovery, verifies the live model/app, and uses `expected_version`. It never edits Scout. A config hash prevents running/scheduling an unapplied local revision. Runs pin the agent version and save the exact request under ignored `var/compliance/requests/` before submission. Retrying the same request ID uses the same idempotency key/body; changed version/mode is rejected. Status, collection and deployment are scoped to this agent.

Collection requires a clean `end_turn`, validates schema and semantic gates, paginates actual tool events, and writes an immutable ignored report to `var/compliance/ses_ID.json` with actual consumed micro-USD. Unknown/failed receipt shapes cannot establish an approved shortlist. Audit recommendations without receipts remain proposals in `assessments`/`unconfirmed_reviews`, not approved companies.

After Felix publishes the `review_context` extension and paginated queue interface from this PR, validate the read path in audit. Inspect evidence and rules before switching:

```sh
pnpm compliance apply --mode enforce
pnpm compliance run --request-id compliance-enforce-001
pnpm compliance status --session ses_ID
pnpm compliance collect --session ses_ID
pnpm compliance deploy --enabled true --validated-session ses_ID
```

Enabling requires a clean session from the current enforce version with working review context, complete coverage, no unconfirmed decisions and no unexpected tools/read-call overruns. The recurring prompt contains no frozen timestamp; the cron runs every 15 minutes in UTC with a pinned version and $0.30 per run. Applying a new version does not repin an existing cron; validate then rerun `deploy`. `deploy --enabled false` pauses it. Do not enable while the live app lacks the required context tool. Missing payment or child enforcement leaves affected offers pending; it does not prevent reviewing other fully evidenced clusters.

The Foundry extension is read-only plus backward-compatible queue cursors; no migrations or new review statuses. Existing `review` writes approve/reject and its decision log. Missing evidence is represented only in the report, preserving the existing database contract. Responses still obey the MCP size ceiling: request fewer leads on oversize, and hold if even one cannot fit.

## Validation scope

The test suite uses synthetic in-memory rows/assessments, never production fixtures. It covers B2B/B2C/B2A eligibility, legal uncertainty, weak economics, incomplete evidence, unavailable payments, duplicate IDs, receipt validation, ranking/backlog/shortfall, exact run retry, budget/tool constraints, evidence pagination and queue cursors after review mutations. Policy copy covers in-person work, false claims, AI disclosure, refunds and outreach limits. A model audit against actual pending evidence is recorded separately; passing schema tests is not proof that every model judgment is correct.

Verified on Nov 8, 2026 UTC: `pnpm check` passes all 93 tests, lint, TypeScript and production build. Native agent `agt_77ak60rq7b4q6c951gvnqvvzdr` is in audit mode at version 2. Deployment `dep_1b4ktt0hvv09gf6k9gwezx19a6` is pinned to that version and **paused**.

The first live audit (`ses_s6qr1jpbckt3nq96ntjmvg0hbz`, version 1) spent 131,124 micro-USD. It kept four clusters pending but returned bare source-URL placeholders, which collection rejected. Its event log also showed seven searches, prompting the explicit tool-use audit/activation guard. Naïve refused a follow-up above the session's remaining preflight budget; no cap was raised. The revised audit (`ses_hh5kgjj2n8rqfgqk0vd07rr6fd`, version 2) spent 38,929 micro-USD, passed collection with zero tool-limit violations, and returned zero shortlisted/eight shortfall because the live app does not yet expose `review_context`. Its accepted report is stored locally in ignored `var/compliance/`; no review writes or outreach occurred. Publishing the MCP extension, then validating an enforce pass, remains required before cron activation.
