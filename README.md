# Auto Foundry

**A company that makes companies.**

The implementation follows [Felix's build plan](docs/AUTO_FOUNDRY_BUILD.md), the project's source of truth for architecture and build order.

Auto Foundry is an autonomous holding company built on the Naïve SDK. It finds demand, spawns a small agent-run company to serve it, measures whether that company can acquire paying customers, and kills it if it can't. The foundry learns from every death and casts the next one better.

No human picks the niches. No human runs the subsidiaries. People set the rules and the budget; the company does the rest.

## How it works

1. **Scout** runs every 15 minutes and harvests demand signals with Naïve's data and social-data tools: businesses with outdated websites, stores with visible problems, people publicly asking for help. It clusters and scores the signals.
2. **CEO** spawns a company when a cluster is big enough and unserved. A child is a set of agents cloned from a template, with its own inbox, site, and budget, and its leads already loaded. Every child lives inside the foundry's Naïve org.
3. **Children** acquire customers the only way a two-day-old company can: by delivering the finished thing first (a live website, a store audit, a translated listing) and charging a fixed price to keep it. They reach businesses through contact forms, email, and X, and answer inbound replies at any hour. Every child reports cost per touch and payments to the foundry.
4. **CEO** kills on CAC. A child that burns its budget without a paying customer is shut down and its lessons are logged. A cluster that converts gets a sibling.
5. **Compliance** checks every new message template and piece of web copy against the rules file: B2B only, AI disclosure in the first sentence, no false claims, refund terms stated.

The only human approval gate is a new message template or new web copy. Everything else runs on `allow`.

## Planned layout

The repo currently holds a Next.js dashboard starter with mock data. We're building the pieces below during the hackathon.

- `agents/`: the foundry's own agents (Scout, CEO, Compliance) as `.agent.yaml` files and prompts
- `templates/`: child company templates (local-site, shopify-fix, room-services, app-localize) with niche and lead placeholders
- `foundry` app: Postgres ledger, the MCP tools agents call (`spawn`, `kill`, `log_touch`, `log_payment`, `get_metrics`, `checkout_link`), the paid-order endpoint, and the dashboard (lineage tree, per-company funnel, spend and revenue)

## Stack

Naïve runs the agents, models and budgets, identities and inboxes, the managed browser, demand data, the company board, and app hosting for the child sites and the foundry app. The foundry app takes payments through Naïve's store checkouts, and Naïve tells it when one is paid.

## Status

Being built at the Naïve × Y Combinator Autonomous Company Hackathon, November 7–8, 2026. The repository currently contains the demo dashboard with sample metrics; Felix's build plan describes the operating system we are implementing.
