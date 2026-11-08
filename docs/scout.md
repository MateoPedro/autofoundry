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

After inspecting a successful bounded pass:

```sh
pnpm scout deploy
pnpm scout collect
```

This creates or updates a single deployment, cron `*/15 * * * *`, UTC, `loose`, **300,000 micro-USD/run**, pinned to the applied agent version. Repeating the command updates the same schedule; it refuses to choose between multiple existing schedules. `loose` schedules do not guarantee results are ready within 15 minutes.

There are 96 scheduled times per day. $0.30 is a per-run ceiling; the $3 agent cap may pause work well before all runs finish. Scheduling never raises that cap. In local mode, scheduled outputs stay in Naïve sessions until the collector runs on this machine. The hosted agent has no access to this checkout's filesystem. A persisted JSON artifact also does not prove its source claims are true: review the linked evidence before downstream use.

## Connect Felix's Foundry

Once #10 exposes the contract tools and a real Foundry app ID:

```sh
pnpm scout apply --foundry-app app_ID
pnpm scout run --query "Continue one existing eligible cluster"
# Verify add_leads receipts and deduplication in Foundry, then repin the deployment:
pnpm scout deploy
```

This adds `apps` scoped to the supplied app ID, with `edits_apps: false`, and exactly `foundry.list_clusters` and `foundry.add_leads`. The app must be named `foundry`. No explicit MCP URL or bearer goes in the agent config: native app tools use Naïve's injected token. No spawn, funding, payment, review, messaging, shell or browser tools are granted.

Foundry upserts clusters by stable label and deduplicates leads by `(cluster, external_id)`. Scout uses real source IDs, with a canonical business URL fallback, and retries the identical write at most once. Only the service's receipts establish saved counts. End-to-end native app visibility and retry handling remain to be verified against Felix's running service.

## Monid / X source (#13)

Maps and the bounded local Monid X source are verified. Follow [the Monid workflow](monid.md) to discover endpoints, run a fixed X search, and feed its receipt to `pnpm scout run --source`. Scout keeps the run ID, source post URLs/IDs and reported micro-USD in lead `data`. Results use the same `add_leads` payload and may never contact an account.

Monid documents a [Streamable HTTP MCP server](https://docs.monid.ai/guide/quickstart-mcp.html) at `https://mcp.monid.ai/v1`, with account authorization. Its [X guide](https://monid.ai/blog/tweets-and-search-without-the-x-api-tier) describes TikHub keyword/profile reads; [execution pricing](https://docs.monid.ai/guide/pricing.html) depends on the selected endpoint. Discovery/inspection are free; execution uses the Monid wallet.

The hosted config does **not** expose generic Monid execution. The local API and MCP authentication checks succeeded, and the fixed X source returned real posts. Unattended source execution needs a narrow tool in Felix's existing service and a separately enforced aggregate Monid spending limit. Naïve's agent budget must not be treated as a Monid budget. No Monid key belongs in the repository, prompt, or MCP URL.
