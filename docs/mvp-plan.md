# AutoFoundry build plan

> **Superseded in part (Nov 8).** The shared-crew design replaced the per-company crew described here: seven fixed agents serve every company, and a company is rows in the foundry's database. See [the foundry contract](foundry-contract.md) and [operations](operations.md).

The team has adopted [Felix's AutoFoundry build plan](AUTO_FOUNDRY_BUILD.md) in full. It is the source of truth and supersedes the earlier MVP architecture.

Follow its build sequence:

1. Verify Naïve access and the required platform capabilities.
2. Build the foundry fullstack app, Postgres tables, MCP tools, and Stripe webhook.
3. Implement Scout and its demand-discovery schedule.
4. Make the local-site child work by hand.
5. Implement the CEO and the automated spawn/funding/kill loop.
6. Add Compliance, the lineage/funnel dashboard, and the demo walkthrough.

The application is currently a Next.js demo with browser-memory state. Treat the full build document and product README as implementation targets until the relevant workflow has been verified.

Codex and Claude Code both follow the shared instructions in `AGENTS.md` and `CLAUDE.md`.
