# AutoFoundry: shared coding instructions

AutoFoundry is an autonomous company factory and accelerator, built by Mateo and Felix for the Naïve hackathon. Use these instructions for both Codex and Claude Code.

## Current state

- Next.js App Router, TypeScript, Node.js 24, pnpm 11.25.0.
- The portfolio dashboard uses browser-memory demo state in `src/lib/studio.ts`.
- Spawn, fund, and stop are simulated; refreshing resets the studio.
- `/api/health` is the only implemented server endpoint.
- No Naïve, Monid, AgentMail, or Mobilerun integration is implemented yet.
- `docs/project-concept.md` is the original, unverified brief. Prefer current source code and official provider documentation when checking capabilities.

## Product direction

The user requires **SDK-first, low-code** implementation. Follow `docs/naive-integration-plan.md`. Use `@usenaive-sdk/managed-agents` and Naïve's native template installs as the company factory. Keep custom code to a thin dashboard and authenticated server-side SDK calls. Build one complete company workflow, then make it reproducible across the portfolio.

- **Naïve:** managed agents, teams, sessions, execution budgets, and workflow events. Make this the core agent runtime.
- **Monid:** discover, inspect, and run external research/data tools.
- **AgentMail:** a company inbox for customer requests and delivery conversations.
- **Mobilerun:** an actual mobile-app step with a verifiable result returned to the workflow.
- **AutoFoundry:** playbook selection, portfolio UI, and human operating controls over Naïve's native resources.

Read the official docs before implementing an adapter:
- https://usenaive.ai/docs
- https://docs.monid.ai/
- https://www.agentmail.to/docs/
- https://docs.mobilerun.ai/

Provider capabilities overlap. Choose one owner for each operation and record the boundary; avoid duplicate inboxes or duplicate tool calls across providers. Do not infer an incorporation API from the original brief.

## Working together

The user has requested collaboration between Codex and Claude Code. Codex coordinates task boundaries and reviews integration; Claude Code can implement or review a specific assigned task. These roles can change when the user requests it.

- Read `README.md`, `docs/mvp-plan.md`, and the assigned GitHub issue first.
- Use a separate branch and, when editing concurrently, a separate worktree. Never have two agents edit the same checkout simultaneously.
- Agree on API contracts and shared types before parallel implementation.
- Keep unrelated changes out of each task. Preserve other contributors' work.
- Report changed files, validation, assumptions, and unresolved items at handoff.
- Never claim a provider is integrated or an external action succeeded without a verified response or artifact.

## Engineering

- Keep the single Next.js application. Use native SDK templates, teams, persistence, events, files, and budget controls; add a custom service/database only for a demonstrated gap.
- Keep credentials and provider adapters on the server. Never commit secrets or put them in `NEXT_PUBLIC_` variables.
- Keep live Naïve cost in its exact integer micro-USD; convert only for display. The existing cents-based portfolio pool is demo data.
- Use Naïve's budget enforcement and actual credit balance. Do not rebuild an allocation ledger or present a period cap as a lifetime studio limit.
- Recover company resources from native install/project context and preserve the owning organization boundary.
- Make retries safe against duplicate resources, deliveries, and charges.
- Distinguish cancelling one session from fully shutting down a company. Use native operator controls for full shutdown until a supported complete flow is implemented; do not claim partial cleanup stopped all work.
- Distinguish simulated activity from real provider results in the UI.
- Keep external publishing, outgoing messages, purchases, and paid provisioning within the user's explicit authorization. Provider integration work alone does not authorize those actions.

## Validation

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check` runs all four. Add meaningful tests for budgets, persistence, workflow transitions, and retry behavior when those features change. Verify UI changes in a browser. CI runs on pushes to main and pull requests.
