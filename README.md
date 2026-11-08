# Auto Foundry

**A company that makes companies.**

The implementation follows [Felix's build plan](docs/AUTO_FOUNDRY_BUILD.md) for the architecture and build order. The [foundry contract](docs/foundry-contract.md) is current where they differ: a fixed shared crew of seven agents replaced the plan's per-company agents.

Auto Foundry is an autonomous holding company built on the Naïve SDK. It finds demand, opens a company to serve it, measures whether that company can acquire paying customers, and kills it if it can't. The foundry learns from every death and casts the next one better.

No human picks the niches. No human runs the subsidiaries. People set the rules and the budget; the company does the rest.

## How it works

Seven fixed agents serve every company, however many exist: Scout, Compliance, Creator, VC, Outreach, Closer and Feedback. A company is rows in the foundry's database (an offer, leads, samples, a grant, a status and decisions), not agents. Two timers start work: Scout every 2 hours and VC every 5 minutes. Every other step starts when the step before it finishes, through a board card the foundry creates.

1. **Scout** runs its four business playbooks every 2 hours (maps, reviews, app store, jobs) and saves clusters of demand signals with their leads. It never contacts anyone.
2. **Compliance** is woken when the cycle's last Scout run ends. It screens the batch of about 10 ideas down to 8 to 12 experiments against the rules file.
3. **Creator** is woken for each approved cluster. It writes the offer, opens the company (rows only) and builds a free sample page for each of its first 5 leads. The foundry serves each page at `<FOUNDRY_URL>/s/<lead_id>`.
4. **VC** checks every 5 minutes. It first runs `reconcile`, which creates any card the records say is missing. It then funds a proposed company, grants more to one that converts, or kills one that can't acquire customers. A grant is the company's spending limit.
5. **Outreach** sends each sampled lead the offer's first message from one shared inbox, and a follow-up after about 20 hours if there is no reply.
6. **Closer** answers replies to the shared inbox, sends checkout links and delivers what buyers pay for. It says it is an AI assistant if asked.
7. **Feedback** turns VC's fund and kill decisions into notes for Scout's memory. A company's first payment can lead to a sibling company.

One **Launch** button on the dashboard starts all of this, and one **End** button stops every agent. End deletes nothing, and Launch picks up where End stopped. Only a signed-in operator sees the buttons. See [operations](docs/operations.md).

## Layout

- `agents/`: the seven agents as `.agent.yaml` files, with prompts in `agents/prompts/`
- `rules/`: the Compliance and idea-screen rules
- `scripts/`: the `pnpm scout`, `parent`, `compliance`, `crew` and `foundry:key` commands that apply the agents and set up the crew
- `migrations/`: the foundry app's Postgres schema
- `src/`: the foundry app. It holds the Postgres ledger, the MCP tools agents call (`spawn`, `fund`, `kill`, `reconcile`, `log_touch`, `find_lead`, `publish_sample`, `checkout_link` and others), the sample pages at `/s/<lead_id>`, the paid-order endpoint, the Launch and End endpoints, and the dashboard
- `docs/`: [the foundry contract](docs/foundry-contract.md), [operations](docs/operations.md) and the per-agent runbooks

## Stack

Naïve runs the agents, models and budgets, the shared identity and inbox, the managed browser, demand data, the company boards, and app hosting for the foundry app. The foundry app takes payments through Naïve's store checkouts, and Naïve tells it when one is paid.

## Status

Being built at the Naïve × Y Combinator Autonomous Company Hackathon, November 7–8, 2026. The repository currently contains the demo dashboard with sample metrics; Felix's build plan describes the operating system we are implementing.
