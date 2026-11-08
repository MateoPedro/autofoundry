# Building AutoFoundry together

Read [Felix's build plan](docs/AUTO_FOUNDRY_BUILD.md) before starting a task. The team has adopted it as the source of truth. `AGENTS.md` and `CLAUDE.md` keep Codex and Claude Code aligned with the same plan.

Connect this checkout to the shared Naïve company using [the local setup guide](docs/naive-setup.md). The SDK and CLI are pinned in the project; `pnpm naive:check` verifies access without provisioning resources.

Clone the shared repository, install Node.js 24 and the pinned pnpm version, then run `pnpm install` and `pnpm dev`.

```sh
git clone https://github.com/MateoPedro/autofoundry.git
cd autofoundry
git switch -c codex/short-feature-name
```

Use a separate branch for each feature. Open a pull request into `main`; ask the other teammate to review when practical. Keep changes small so dashboard and agent work can merge frequently. Pull the latest `main` before starting each new branch. Never force-push the shared `main` branch.

Run `pnpm check` before opening a pull request. CI runs lint, type checks, governance tests, and a production build. Add tests when changing budget rules, persistence, or workflow transitions; visual-only edits can use browser verification. Tests use an in-memory PGlite database by default; set `TEST_DATABASE_URL` to a Postgres server (for example `postgres://postgres@127.0.0.1:5432/postgres`) to run them against real Postgres, as the CI `postgres` job does. Each test creates its own database there.

Coordinate changes to `src/lib/studio.ts` because both tracks use its types. Put new server adapters under `src/lib/server/`, import `server-only` there, and call them through API routes or server actions. Enforce budget and authorization rules on the server before enabling external actions.

Do not commit API keys, `.env.local`, customer data, generated private company documents, or provider tokens. Add documented environment variable names to `.env.example` when an integration is implemented.

No deployment is configured yet. Keep demo and live behavior visibly distinguishable when adding integrations.
