# Creator and VC (#17)

Implements the Creator and VC side of [the foundry contract](foundry-contract.md), sections 1 and 5. Creator turns approved clusters into offers and spawns unfunded companies from approved offers. VC makes first grants, grants more to companies that convert, and kills the rest. Neither contacts anyone.

| | Creator | VC |
|---|---|---|
| Config | [`agents/creator.agent.yaml`](../agents/creator.agent.yaml) | [`agents/vc.agent.yaml`](../agents/vc.agent.yaml) |
| Prompt | [`agents/prompts/creator.md`](../agents/prompts/creator.md) | [`agents/prompts/vc.md`](../agents/prompts/vc.md) |
| Tools (`foundry.*`) | `list_clusters`, `list_offers`, `review_context`, `propose_offer`, `spawn`, `find_lead`, `publish_sample`, `log_touch`, `log_decision`, `get_metrics`, `get_company`; plus `web_fetch` | `reconcile`, `list_clusters`, `fund`, `kill`, `log_decision`, `get_metrics`, `get_company` |
| Woken by | Cards: "Design", "Sample", "Revise" and "Sibling". No schedule | One schedule, every 5 minutes (`*/5 * * * *`) |
| Per run | 300,000 micro-USD ($0.30) | 300,000 micro-USD ($0.30) |
| Agent cap | 2,000,000 micro-USD/day ($2), $0.50 per task | 15,000,000 micro-USD/day ($15), $0.50 per task |

Both use `zai-org/GLM-5.2-FP8`, the model Scout uses and the only one in the org's catalog that supports `loose` windows (checked Nov 7). Both are two of the seven shared agents; no company has agents of its own ([contract](foundry-contract.md#4-the-shared-crew)).

## Creator

Creator turns approved clusters into offers, opens companies, and builds each company's free samples. A card's title carries the ids it needs.

| Card title | What Creator does |
|---|---|
| `Design a company for cluster <cluster_id>` | Reads the cluster's leads (`review_context`), writes an offer (`propose_offer`), calls `spawn`, then builds and publishes a sample for each of the company's first 5 leads (`publish_sample`). It logs a hold when the cluster can't be served. |
| `Sample new leads for <company_id>` | Builds samples for the leads a second or third grant added. Each published sample goes to Outreach. |
| `Revise the offer for cluster <cluster_id> after <company_id> was killed` | Writes a revised offer if a change answers VC's kill reason, then spawns and samples it. Otherwise it logs a hold. |
| `Consider a sibling of <company_id>` | After the company's first payment, spawns a second company from the same offer or designs one for a similar cluster. Otherwise it logs a hold. |

`spawn` writes rows only (the company, 5 leads and a decision). Creator builds each sample from the lead's own site with `web_fetch`, publishes it with `publish_sample`, and the foundry serves it at `<FOUNDRY_URL>/s/<lead_id>`. A lead whose site can't be read gets a `failed` touch instead (`log_touch`). The company becomes `proposed` once every lead has a sample or a failed touch. Creator pays for samples out of its own budget, before any grant.

## VC

VC runs every 5 minutes. Each pass:

1. Calls `foundry.reconcile`, which creates any card the records say is missing (see [the sweep](foundry-contract.md#the-sweep)).
2. Kills companies that can't convert, grants more to ones that do, and makes first grants to proposed companies.
3. Kills a proposed company it decides not to fund, so its slot frees for the next cluster.

A first grant creates an Outreach "Contact" card for each sampled lead. VC's cap is $15 a day, which covers 288 passes at up to about $0.05 each. VC writes a hold only when a company is waiting on it, not on every quiet pass.

## Commands

```sh
pnpm parent creator check
pnpm parent creator apply --foundry-app app_ID
pnpm parent creator run
pnpm parent creator status
pnpm parent vc deploy
```

`check`, `apply`, `run` and `status` work for `creator`, `vc`, `feedback`, `outreach` and `closer`. `check` validates the config offline: micro-USD budgets, default deny, and exactly the contract's tools for that agent. `apply` creates or updates only an agent tagged `project: autofoundry` with the matching `role`, adds the `apps` tool (set to `deny`, with the foundry app in `allowed_apps`), and refuses an app not named `foundry`. `run` starts one session; reuse `--request-id` to retry a lost response. `deploy` works only for `vc`, the one agent with a schedule. It creates or updates the single cron deployment, pinned to the applied version, **created off**. Launch turns it on and End turns it off ([operations](operations.md)).

## Before going live

1. The foundry app runs a build with migration `0009_shared_crew.sql`, and `FOUNDRY_URL` is set. [Operations](operations.md) lists the whole rollout in order.
2. Compliance is running in screen mode (#18). Creator can only propose for approved clusters.
3. Scout (#11) has written clusters with leads.
4. One manual `run` of each, with the session checked.

VC's thresholds stay placeholders until the cost experiment (#22). Run VC by hand (`pnpm parent vc run`) for the first one or two grants if you want to watch them, then set `funding_policy` and press Launch.

## Calls made while building

- **Runs get $0.30 and tasks $0.50, as Scout's and Compliance's do.** Naïve quotes each model call before it runs, and the first live Creator run at $0.20 was refused with `402 budget_exceeded` ("the remaining budget for this task is below the pre-flight quote").
- **`list_offers` is new.** Without it, Creator can't see its own pending, approved or rejected offers, since it keeps no memory between cards. It would re-propose for the same cluster on every card and could only find approved offers through the last 50 decisions.
- **Spawn request ids are `<offer_id>-<n>`.** `n` is 1 for the first company from an offer and 1 plus the offer's companies for a sibling, so a retry reuses the same id and gets the same company.
- **A second company from the same offer** is spawned only after an earlier one has revenue and the cluster still has free leads.
- **Message rules follow [the Compliance rules](../rules/compliance.md).** Both messages state the USD price, the refund terms ("If it isn't right, reply within 14 days for a full refund") and an opt-out line. Offers are approved on submission (owner policy, Nov 8), so `propose_offer` checks only the channel and `{{sample_url}}`; the messages still have to follow the rules.
- **VC's thresholds** are placeholders until #22. It kills a company when every lead was contacted 24+ hours ago with no reply, or when 90% of the grant is spent with no payment and fewer than 2 replies, or when more than half its touches failed, or when a reply costs over $3 after every lead was contacted with no payment. It grants more after a payment, or after 2+ replies with 70% of the grant spent. It never kills within 24 hours of funding unless every touch failed.
- **`parent_offer_id`** is set when Creator revises a rejected offer as well as a killed company's offer.
- **Creator reads `review_context` too.** Before writing an offer it reads up to 5 of the cluster's leads: Scout's evidence and issues, `buyer_type`, `channel`, contact routes and the `revenue` hypothesis. It picks `contact_form` or `email` by the route most leads have, and skips a cluster whose leads need a reply channel that doesn't run yet. The contract's tool table now lists Creator next to Compliance for this tool.
- **VC doesn't fund agent-buyer companies yet,** because selling to agents through a paid tool catalog hasn't been verified (contract section 1).
