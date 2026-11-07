# Building AutoFoundry together

Clone the shared repository, install Node.js 24 and the pinned pnpm version, then run `pnpm install` and `pnpm dev`.

```sh
git clone https://github.com/MateoPedro/autofoundry.git
cd autofoundry
git switch -c codex/short-feature-name
```

Use a separate branch for each feature. Open a pull request into `main`; ask the other teammate to review when practical. Keep changes small so dashboard and agent work can merge frequently. Pull the latest `main` before starting each new branch. Never force-push the shared `main` branch.

Run `pnpm check` before opening a pull request. CI runs lint, type checks, governance tests, and a production build. Add tests when changing budget rules, persistence, or workflow transitions; visual-only edits can use browser verification.

Coordinate changes to `src/lib/studio.ts` because both tracks use its types. Put new server adapters under `src/lib/server/`, import `server-only` there, and call them through API routes or server actions. Enforce budget and authorization rules on the server before enabling external actions.

Do not commit API keys, `.env.local`, customer data, generated private company documents, or provider tokens. Add documented environment variable names to `.env.example` when an integration is implemented.

No deployment is configured yet. Keep demo and live behavior visibly distinguishable when adding integrations.

## Codex and Claude Code

Both agents follow `AGENTS.md`; Claude Code also reads `CLAUDE.md`. Use an explicit task and separate branches/worktrees when both agents implement changes at the same time. Keep shared API contracts coordinated, and review the other agent's changes before merging.

Claude Code's first review task is in `docs/claude-code-first-task.md`. Once Claude Code is installed and signed in, run it from this repository:

```sh
claude -p "Read CLAUDE.md and complete docs/claude-code-first-task.md. Return your review without editing files." --permission-mode plan
```

Codex can run and resume scoped Claude Code sessions through its CLI and review the resulting work. Sign-in is local to each developer's machine; credentials are never shared through the repository.
