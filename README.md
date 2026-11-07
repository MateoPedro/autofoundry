# AutoFoundry

**An autonomous company factory and accelerator.**

Built by Mateo and Felix for the Naïve Autonomous Company Hackathon. AutoFoundry turns a theme into a portfolio of small companies, gives each one an agent team and a budget, and helps decide which ventures to fund or stop.

## Run locally

Install Node.js 24 and pnpm (the exact pnpm version is pinned in `package.json`). With nvm, run `nvm install` and `nvm use` in this directory.

```sh
corepack enable
pnpm install
pnpm dev
```

Open [localhost:3000](http://localhost:3000). No API keys or database are needed. `GET /api/health` returns a demo health response.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## What works today

- Responsive portfolio dashboard with two sample companies.
- Spawn a mock company from a theme and inspect its sample activity.
- Allocate simulated funding with reserve checks and a per-company cap.
- Stop a company and return its unspent simulated budget.
- Tests for budget conservation and governance limits; GitHub Actions validation.

This is a development starter: companies live in browser memory and reset on refresh. Metrics are samples; agent roles are mocked. There is no live AI, shared database, incorporation, payment, external deployment, or resource shutdown yet. The browser budget policy must move behind server authorization before live integrations can spend money or perform actions.

## Two-person build plan

| Track | Main files | First deliverable |
| --- | --- | --- |
| Dashboard & demo | `src/app/page.tsx`, `src/app/globals.css` | Company detail view, progress states, metrics, demo polish |
| Naïve SDK & playbooks | `src/app/api/`, `src/lib/` | Read/preview/apply native company templates and observe their work |

Pick one track each. Agree on shared types before editing them in parallel. Follow the [SDK-first, low-code integration plan](docs/naive-integration-plan.md), [MVP plan](docs/mvp-plan.md), and [contribution workflow](CONTRIBUTING.md). Naïve's native template installs will own company provisioning and durable state.

## Project map

```text
src/app/                 Dashboard, layout, styling, and API routes
src/lib/studio.ts        Shared company types and demo budget policy
tests/                   Governance behavior tests
docs/mvp-plan.md         Scope, architecture, work split, and demo script
docs/project-concept.md  Original planning brief (unverified research)
.github/                 CI and contribution templates
```

## Demo target

Theme → idea → agent team → generated landing page → measured activity → fund or stop.

Make that loop work for one company first, then scale the demo toward ten. Keep external actions and spend behind explicit server-enforced policy. Use test credentials while building; keep secrets in `.env.local`, which is ignored by Git.
