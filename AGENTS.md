# AutoFoundry: project instructions

## Source of truth

The user has chosen to follow **Felix's plan in `docs/AUTO_FOUNDRY_BUILD.md` in full**. Read it before implementing any task. It supersedes earlier plans, including the alternative native-template-catalog approach on `codex/claude-collaboration`.

Follow the plan's product loop: Scout finds demand → CEO spawns a child → the child delivers a sample and acquires a customer → verified outcomes inform funding and kill decisions.

## Architecture and sequence

- Naïve is the agent runtime and operating platform. Use its SDK, CLI, agent configuration, company board, and deployments as described by Felix.
- The foundry is a Naïve fullstack app with Postgres tables, an MCP endpoint, Stripe webhooks, and a lineage/funnel dashboard.
- Implement `foundry.spawn`, `foundry.kill`, logging, and metrics tools according to the plan. Children consist of an identity/inbox, their agents, an app, and board cards.
- Follow Felix's phases: hour 0–1 verification; foundry app; Scout; local-site child by hand; CEO and automated spawn; Compliance and demo polish.
- Provider and acquisition-channel choices follow Felix's build document. Verify current SDK/API syntax, capabilities, permissions, and account availability in the first phase; record actual results.
- Keep the implementation low code by using Naïve's primitives and the plan's small application tools.

## Current implementation

The repository currently contains a Next.js/TypeScript demo. Company state is in browser memory, metrics and agent activity are samples, and `/api/health` is the only API route. The files and live capabilities described in the product README are build targets. Do not claim they are implemented until verified.

## Codex and Claude Code

The user has requested that Codex and Claude Code work together. Coordinate explicit tasks against Felix's plan, use separate branches/worktrees when editing concurrently, and hand off changed files, validation, and blockers. Agree on shared interfaces before parallel edits. Preserve Felix's work and other contributors' changes.

## Development and validation

- Current app: Node.js 24, pnpm 11.25.0, Next.js App Router, TypeScript.
- Use feature branches and pull requests. Keep changes focused on the assigned phase.
- Keep credentials server-side and out of Git. Never print provider tokens or read `.env` files into an agent review.
- Use integer micro-USD for Naïve API amounts; Stripe amounts use their documented currency units. Keep unit conversion explicit.
- Use actual provider responses, event IDs, and verified payment events when reporting execution, cost, or revenue.
- Test changes to budgets, retries, state transitions, and payment handling meaningfully. Run `pnpm check` for runtime changes; verify UI changes in a browser. Documentation-only edits need link and diff checks.
- External messages, publishing, purchases, and paid provisioning must stay within the user's authorized scope. Build and test locally without implying that provider access or external-action authorization already exists.
