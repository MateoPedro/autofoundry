# Creator and Funder (#17)

Implements the Creator and Funder side of [the foundry contract](foundry-contract.md), sections 1 and 5. Creator turns approved clusters into offers and spawns unfunded companies from approved offers. Funder makes first grants, grants more to companies that convert, and kills the rest. Neither contacts anyone.

| | Creator | Funder |
|---|---|---|
| Config | [`agents/creator.agent.yaml`](../agents/creator.agent.yaml) | [`agents/funder.agent.yaml`](../agents/funder.agent.yaml) |
| Prompt | [`agents/prompts/creator.md`](../agents/prompts/creator.md) | [`agents/prompts/funder.md`](../agents/prompts/funder.md) |
| Tools (`foundry.*`) | `list_clusters`, `list_offers`, `propose_offer`, `spawn`, `log_decision`, `get_metrics`, `get_company` | `list_clusters`, `fund`, `kill`, `log_decision`, `get_metrics`, `get_company` |
| Schedule | hourly, on the hour (`0 * * * *`) | hourly, at half past (`30 * * * *`) |
| Per run | 200,000 micro-USD ($0.20) | 100,000 micro-USD ($0.10) |
| Agent cap | 2,000,000 micro-USD/day ($2) | 1,000,000 micro-USD/day ($1) |

Both use `zai-org/GLM-5.2-FP8`, the model Scout uses and the only one in the org's catalog that supports `loose` windows (checked Nov 7). Funder runs half an hour after Creator, so a company Creator spawns is reviewed in the same hour.

## Commands

```sh
pnpm parent creator check
pnpm parent creator apply --foundry-app app_ID
pnpm parent creator run
pnpm parent creator status
pnpm parent creator deploy
```

The same commands work for `funder`. `check` validates the config offline: micro-USD budgets, default deny, and exactly the contract's tools for that agent. `apply` creates or updates only an agent tagged `project: autofoundry` with the matching `role`, adds the `apps` tool scoped to the foundry app with `edits_apps: false`, and refuses an app not named `foundry`. `run` starts one session; reuse `--request-id` to retry a lost response. `deploy` creates or updates the single cron deployment, pinned to the applied version.

## Before going live

These have to be true first, in this order:

1. The foundry app runs a build that includes `spawn`, `fund` and `kill` (#16, merged) and this branch's `list_offers`.
2. `templates/child/` exists (#12). Until it does, `spawn` answers `internal` and Creator logs a hold.
3. Compliance (#18) is running. Creator can only propose for approved clusters and only spawn approved offers.
4. Scout (#11) has written clusters with leads.
5. One manual `run` of each, with the session checked: an agent session calling native app tools hasn't been verified end to end yet.

Funder's deployment waits for the cost experiment (#22). Run Funder by hand (`pnpm parent funder run`) for the first one or two grants, then set `funding_policy` and deploy it.

## Calls made while building

- **`list_offers` is new.** Without it, Creator can't see its own pending, approved or rejected offers, since it keeps no memory between runs. It would re-propose for the same cluster every hour and could only find approved offers through the last 50 decisions.
- **Spawn request ids are `<offer_id>-<n>`.** `n` is 1 plus the offer's companies that aren't failed or spawning, so a retry after a failure reuses the same id and resumes.
- **A second company from the same offer** is spawned only after an earlier one has revenue and the cluster still has free leads.
- **Refund line.** Creator writes "If it isn't right, reply within 14 days for a full refund" into every outreach message, because the Compliance rules ask for refund terms. Someone still has to be able to issue that refund (#15).
- **Funder's thresholds** are placeholders until #22. It kills a company when every lead was contacted 24+ hours ago with no reply, or when 90% of the grant is spent with no payment and fewer than 2 replies, or when more than half its touches failed, or when a reply costs over $3 after every lead was contacted with no payment. It grants more after a payment, or after 2+ replies with 70% of the grant spent. It never kills within 24 hours of funding unless every touch failed.
- **`parent_offer_id`** is set when Creator revises a rejected offer as well as a killed company's offer.
- **Creator can't see a cluster's lead evidence.** It writes offers from the cluster's label and source. Scout now records each lead's `buyer_type`, `channel` and `revenue` hypothesis in `data`, which is what Creator needs to choose the channel and price. A lead sample on `list_clusters` would give it that. Until then, Creator skips clusters sourced from X, Reddit, Hacker News or GitHub, whose leads need reply channels that don't run yet.
- **Funder doesn't fund agent-buyer companies yet,** because selling to agents through a paid tool catalog hasn't been verified (contract section 1).
