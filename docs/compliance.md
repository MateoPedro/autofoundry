# Compliance

**Owner policy (Nov 8):** Compliance only runs the quick idea screen, right after each Scout cycle: about 10 ideas in from Scout's four business playbooks, 8–12 approved for Creator when there are enough. Offers are approved on submission, and the detailed review below is no longer part of the live flow.

## Live: screen each Scout batch

```sh
pnpm compliance apply --mode screen --foundry-app app_ID
pnpm compliance run                      # one manual screen of the latest batch
```

In screen mode the agent can call only `foundry.screen_batch` and `foundry.submit_screen` ([contract](foundry-contract.md#compliance)), and its prompt carries the [idea-screen rules](../rules/idea-screen.md).

Screen mode has **no schedule**. A card wakes it. When the fourth scheduled Scout run of a cycle pings `/api/scout-idle`, the foundry creates a card titled `Screen Scout batch <cycle start>` on Compliance's board. If a run hangs, VC's five-minute sweep creates the same card once the cycle is 90 minutes old. The card key stops a late or extra ping from waking Compliance twice. `pnpm compliance deploy` refuses in screen mode. While the company is stopped (End), no card is created.

`submit_screen` approves the picks and then creates Creator's "Design" cards for the approved clusters, up to the free slots ([contract](foundry-contract.md#the-shared-crew)). The app makes no model calls and needs no new key scopes.

## Quick idea selection: 20 → 8–12

Use this at the idea stage, directly on saved Scout ideas:

```sh
pnpm compliance screen --ideas var/scout/ideas/ID.json --request-id screen-001
```

The [idea-screen rules](../rules/idea-screen.md) drop obvious illegality/harm and clear practical impossibility, then rank interesting, cheap experiments. Unknown demand, prices, contacts, payment rails and API availability are experiment questions, not automatic rejection. Uncertain legal risks are flagged for later checks. Selected ideas are not launch approvals or Foundry review-status changes.

This is one org-level Naïve proxy call using Gemma, with thinking disabled, at most 20 compact summaries and a 2,400-token response limit. No lead verification, external research or tools are called. Contacts and raw lead payloads are excluded from the input. The hosted agent's dollar budget is separate from proxy billing; the screen limits tokens and records the actual billed micro-USD when the trace is available. It does not claim an unverified dollar-price ceiling.

JSON/text reports are saved under `var/compliance/screens/`. The same request ID replays a completed result without another model call. A started request with a missing result blocks a blind paid retry. Every input idea must receive one verdict, and a real shortfall is reported if clear blockers leave fewer than eight. There are no automatic paid repair/retry loops.

## Detailed review before real-world action

Compliance reviews one candidate per hosted run. Saved reviews are combined into the 8–12-opportunity report locally, without another model call. Scout remains owned by Claude; this workflow changes no Scout files or Foundry database interfaces.

The [owner rules](../rules/compliance.md) still cover B2B/B2C/B2A eligibility, evidence/privacy, legal screening, monetization, digital delivery and offer terms. Missing facts remain pending. Approval still requires the complete evidence/economics checks and real Foundry receipts. The smaller format changes how much the agent must write, not the approval standard.

## Run one review

Use Node 24, the existing Naïve login and ignored `.env.local`. Apply the current configuration before running:

```sh
pnpm compliance apply --mode audit
pnpm compliance run --cluster-id cl_ID --request-id review-001
pnpm compliance status --session ses_ID
pnpm compliance collect --session ses_ID
```

For an offer, provide both IDs:

```sh
pnpm compliance run --cluster-id cl_ID --offer-id of_ID --request-id offer-review-001
```

Audit returns recommendations. `apply --mode enforce` enables the existing `foundry.review` write for approve/reject decisions. It cannot contact anyone, spawn, fund, change budgets or edit apps. A request ID pins the exact target, agent version, mode, timestamp and $0.30 session budget; retrying it for a different target is refused. Daily/task caps remain $3/$0.50 in API micro-USD.

Without a target, `run` selects one pending offer or cluster from `list_pending` with limit 1. An empty queue returns a null assessment. Explicit target IDs let the caller continue past cases held for research. The collected result covers that target, not the entire pending queue.

Each run is instructed to use at most two context reads, one web search and one web fetch. Read-call limits are checked from actual events; Naïve enforces the monetary budget. The installed managed-agent API exposes no reasoning-token setting, so this configuration does not claim a hard reasoning-token cap. Reduce work through a single target, bounded lookups and a short verdict; deeper research is an explicit gap instead of an open-ended task.

Held/rejected results contain only target IDs, buyer type, one sentence and up to three research gaps. The model does not fill a business plan with unknown values. Approved results retain the full evidence, jurisdiction, cost/pricing and payment requirements. A clean ending must call `submit_output` with the single assessment.

## Assemble the report

Collect each completed session independently, then run:

```sh
pnpm compliance report --sessions ses_A,ses_B,ses_C --request-id report-001
```

This command is offline: it reads collected checkpoints and writes JSON plus readable text under `var/compliance/reports/`. It makes no API/model calls and cannot change decisions. Confirmed receipts and inspected lead IDs establish shortlist eligibility; an approved concrete offer on an approved cluster is required for ready-for-spawn status. It ranks at most 12 distinct clusters, retains eligible backlog and reports the actual shortfall below eight. Funding/concurrency limits are separate.

If a hosted run ends with error, budget pause or invalid output, `collect` saves a failed checkpoint with its actual cost and returns a nonzero exit status. Include that session in `report`: other reviews remain available and the report is explicitly partial. Failed reviews never become pending assessments or approvals. A still-running session is not collected. Collection preserves immutable checkpoints; repeated identical collection/report generation is harmless.

Reports deduplicate session costs and retain the latest assessment for a target. Unconfirmed decisions, failed runs and tool-use overruns remain visible. No full-cohort generation step can erase the earlier completed reviews.

## Scheduling and validation

Cron remains paused by default. Enabling still requires an explicitly validated enforce session from the current agent version with working review context, confirmed decisions and no tool-limit violations. Reapply/validate/repin after a configuration change. The cron reviews one pending candidate per tick; use explicit target IDs for a selected cohort or held backlog.

Focused tests cover compact/legacy formats, unchanged approval gates, exact-target retry, report assembly, duplicate costs, failure checkpoints, immutable files and receipt-based shortlist eligibility. Verify one existing candidate live before enabling scheduling; discovery does not need to be repeated.
