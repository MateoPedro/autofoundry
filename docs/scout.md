# Scout (#11)

Implements the Scout side of [the foundry contract](foundry-contract.md), sections 1 and 5. Scout researches demand; Compliance reviews clusters; Creator chooses the offer. No outreach or company creation is allowed.

Start with [the single Maps → Monid audit → pending Compliance pipeline](scouting-pipeline.md), including its live handoff receipt and qualification issues found before scheduling.

## Run before Foundry is ready

Use the shared org credentials from [local setup](naive-setup.md). Node.js 24 and the pinned pnpm are required.

```sh
pnpm install
pnpm naive:check
pnpm scout check
pnpm scout apply
pnpm scout run --query "Independent businesses in SF Mission with observable digital gaps and a public business contact route"
```

`apply` creates or updates only the `scout` agent tagged `project: autofoundry, role: scout`. An existing untagged Scout is not overwritten. It sends the SDK an API-shaped config, with integer micro-USD budgets. **Do not pass this source file directly to `naive agent apply -f`: CLI 1.0.3 accepts only `cap_usd` and `max_task_usd` in authored files and converts them. The HTTP API accepts `cap_micro_usd` and `max_task_micro_usd`.** This small loader keeps the contract's micro-USD units explicit.

`zai-org/GLM-5.2-FP8` was listed by the org's live model catalog on November 7. Gemma and Kimi validation passes repeated invalid Maps inputs and ended without output, so Scout uses GLM as the next candidate. Catalog availability is not evidence of quality or cheapest pricing. Check a pass before leaving it scheduled.

`run` starts one session, capped at **300,000 micro-USD ($0.30)**, with `immediate` for interactive validation. The agent has a **3,000,000 micro-USD/day ($3)** cap and a **500,000 micro-USD/task ($0.50)** ceiling. It prints a request ID before the write. If the response is lost, repeat the same focus and `--request-id` to reuse the exact saved request and provider idempotency key. A changed focus/version needs a new ID. Do not blindly rerun without the ID.

Once the session has stopped with `end_turn`:

```sh
pnpm scout status --session ses_ID
pnpm scout collect --session ses_ID
```

The collector writes `var/scout/<session_id>.json`, ignored by Git, with verified session ID/version, the provider's `consumed_micro_usd`, and `batches`/`notes`. Each batch is **exactly the `foundry.add_leads` input**. The wrapper is a local audit artifact, not a second foundry database. Provider usage is recorded as reported; it is not claimed to include independently billed services.

Running `pnpm scout collect` collects the latest 100 Scout sessions. Individual older sessions can be collected by ID. Active, failed, approval-blocked, budget-paused, malformed, duplicate-ID, missing-contact or evidence-free results are not accepted as successful outputs. URL syntax is checked locally; the collector does not independently re-fetch or verify source claims. Recollecting an identical result is harmless; a changed result cannot silently overwrite evidence.

## Recurring passes

The cron only starts Scout; Scout does the research itself with its own tools. Each scheduled run is told one **playbook**, one per source from [Scout ideas](scout-ideas.md): `maps`, `reviews`, `appstore`, `jobs`, `reddit`, `consumer_posts`, `app_wishes` and `agents` (GitHub issues plus agent-builder forums). The recipes are in [Scout's prompt](../agents/prompts/scout.md). Before any paid call, Scout reads every cluster in Foundry with `foundry.list_clusters` (rejected, approved, pending). It skips rejected buyer/problem pairs and clusters a company already serves, and picks an area, category or topic no existing label covers.

**Monid on the schedule.** The hosted agent reaches Monid only through `foundry.monid_read` ([contract](foundry-contract.md#scout)): four fixed read sources (Reddit, X, GitHub issues, Hacker News), the key kept on the foundry app, a price check before every billed run and a daily cap. Scout never gets Monid's generic `monid_run`. The `reddit`, `consumer_posts` and `agents` playbooks use it. To turn it on, set `MONID_API_KEY` (and optionally `MONID_DAILY_CAP_MICRO_USD`, default 100,000 = $0.10/day) as secrets on the foundry app, and redeploy it with migration `0004_monid_reads.sql`.

Try one playbook by hand, then schedule all of them:

```sh
pnpm scout apply --foundry-app app_ID
pnpm scout run --playbook consumer_posts
pnpm scout status --session ses_ID
pnpm scout deploy
```

`deploy` needs foundry mode, because the dedup check reads Foundry. It creates or updates **one deployment per playbook**, each `loose`, UTC, **300,000 micro-USD/run** and pinned to the applied agent version. The prompt names the playbook, so a run never has to know the time or remember the last one. **One run every 3 hours** (00:00, 03:00, … 21:00 UTC), so each playbook runs once a day: 8 runs a day, about $1.06 at the verified ~132,000 micro-USD per pass, inside the $3/day agent cap even if every run spent its full $0.30. Monid spend is separate and capped by the foundry app. The stagger is `STAGGER_MINUTES` in `scripts/scout-playbooks.ts`.

Repeating `deploy` updates the same schedules. It refuses if two deployments run the same playbook, and turns off (never deletes) any other enabled Scout schedule, such as the earlier single generic cron.

`pnpm scout ideas` remains the local, deterministic version of the same sources. A persisted lead does not prove its source claims are true: review the linked evidence before downstream use.

## Connect Felix's Foundry

Once #10 exposes the contract tools and a real Foundry app ID:

```sh
pnpm scout apply --foundry-app app_ID
pnpm scout run --query "Continue one existing eligible cluster"
# Verify add_leads receipts and deduplication in Foundry, then repin the deployment:
pnpm scout deploy
```

This adds `apps` scoped to the supplied app ID, with `edits_apps: false`, and exactly `foundry.list_clusters`, `foundry.add_leads` and `foundry.monid_read`. The app must be named `foundry`. No explicit MCP URL or bearer goes in the agent config: native app tools use Naïve's injected token. No spawn, funding, payment, review, messaging, shell or browser tools are granted.

Foundry upserts clusters by stable label and deduplicates leads by `(cluster, external_id)`. Scout uses real source IDs, with a canonical business URL fallback, and retries the identical write at most once. Only the service's receipts establish saved counts. End-to-end native app visibility and retry handling remain to be verified against Felix's running service.

## Monid / X source (#13)

Maps and the bounded local Monid X source are verified. Follow [the Monid workflow](monid.md) to discover endpoints, run a fixed X search, and feed its receipt to `pnpm scout run --source`. Scout keeps the run ID, source post URLs/IDs and reported micro-USD in lead `data`. Results use the same `add_leads` payload and may never contact an account.

Monid documents a [Streamable HTTP MCP server](https://docs.monid.ai/guide/quickstart-mcp.html) at `https://mcp.monid.ai/v1`, with account authorization. Its [X guide](https://monid.ai/blog/tweets-and-search-without-the-x-api-tier) describes TikHub keyword/profile reads; [execution pricing](https://docs.monid.ai/guide/pricing.html) depends on the selected endpoint. Discovery/inspection are free; execution uses the Monid wallet.

The hosted config does **not** expose generic Monid execution. Scheduled runs use the foundry's capped `monid_read` tool (see [Recurring passes](#recurring-passes)). Naïve's agent budget is not a Monid budget; the foundry app's daily cap is. No Monid key belongs in the repository, prompt, or MCP URL.
