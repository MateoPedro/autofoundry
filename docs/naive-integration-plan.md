# AutoFoundry: SDK-first, low-code integration plan

Reviewed with Claude Code on November 7, 2026. This revision incorporates the user's requirement to use the Naïve SDK and keep custom code minimal. It supersedes the earlier custom database/ledger and orchestration proposals. This is a build plan; the application still runs in demo mode.

## Architecture

AutoFoundry is a thin Next.js interface over `@usenaive-sdk/managed-agents`. Naïve owns company provisioning, agent teams, sessions, durable execution, events, files, usage, and budget enforcement. The dashboard reads and operates those native resources through authenticated server-side SDK calls.

Use Naïve company templates as the factory primitive. A company maps to a native blueprint install identified by its `project` and install ID; its agents and apps come from the install's context and report. Recover the portfolio from Naïve after refresh instead of rebuilding the same state in a separate database.

The official npm registry currently publishes SDK **0.12.3**, ESM-only and compatible with Node 24. Codex inspected the published TypeScript declarations and verified `apps.installs`, `apps.artifacts`, and `apps.companyTemplates` exist. Pin the dependency and compile against its actual types in the first build task.

## Native SDK workflow

| Step | SDK methods | AutoFoundry's small contribution |
| --- | --- | --- |
| Choose a business playbook | `apps.artifacts.list()` | Show available templates and their declared setup questions |
| Preview a new company | `apps.installs.preview()` | Use a unique, stable project identifier; show the resources the template would create |
| Spawn | `apps.installs.apply()` | Apply a published blueprint/template pair, validate its answers, and display the resource report |
| Recover the portfolio | `apps.installs.list()`, `apps.installs.context()` | Render each install's actual agents, roles, and app URLs |
| Observe work | `sessions.list()`, `sessions.get()`, `sessions.events()` or `stream()` | Display native status, ordered events, and results |
| Show costs | `credits.show()`, `credits.spend()`, `agents.spend()` | Format actual provider balance and spend for the selected scope |
| Reuse a successful company later | `apps.companyTemplates.draft()`, `create()`, `list()` | Review a draft and save a private reusable playbook; drafting is metered |

For server-side provisioning, apply a published pair **without a custom declaration**. The documentation distinguishes this from supplying a declaration, which records an install after client-side reconciliation rather than asking the server to provision it. Do not write a custom reconciler.

Template application may start work through native board tasks or schedules. Read the catalog's declared resources, permissions, and budgets before applying; inspect returned refusals and partial results rather than treating any returned install as a fully working business. Use the preview/context/report to map resource names instead of guessing them.

Sources: [SDK apps and installs](https://usenaive.ai/docs/sdk/apps), [templates](https://usenaive.ai/docs/concepts/templates), [TypeScript SDK](https://usenaive.ai/docs/sdk/typescript).

## Provider ownership

- **Naïve:** the execution and company platform, including native teams and durable state.
- **Monid:** research and external data tools.
- **AgentMail:** customer inboxes and email conversations.
- **Mobilerun:** the mobile-app step and its returned result.
- **AutoFoundry:** playbook selection, portfolio presentation, and the human's operating controls.

Attach partner capabilities through Naïve's documented tools, connections, MCP, or template configuration. Verify each partner's authentication and tool schema before enabling it. Choose or adapt a playbook that uses those providers; a generic catalog template is not proof that these integrations are configured. Keep one owner per operation so Naïve's overlapping email/mobile features do not duplicate the partner's work.

## First implementation task

**Native template catalog, preview, and installed-company portfolio using the real SDK.**

1. Add the pinned SDK and a server-only client factory. Require `NAIVE_API_KEY` at request time; keep it out of browser bundles and allow the demo to run without it.
2. Expose thin authenticated Next.js handlers for catalog, install preview, installed companies, and company context. Call the SDK directly and preserve its typed errors.
3. Use the catalog's actual questions and preview response in the dashboard. Keep demo and provider data visibly distinct.
4. Read installs back from Naïve so two clients in the same authorized organization see the same portfolio. Handle cursor pagination; lists return one page at a time.
5. Test with the real SDK's injected `fetch` and recorded/fake responses. Make no live provisioning or inference calls in automated tests.

**Claude Code's initial implementation boundary:** the server-only SDK client and thin native catalog/install read/preview service, plus focused mocked-transport tests. **Codex:** review SDK usage and authentication, then connect the dashboard. Coordinate package/lockfile edits through one owner. Keep implementation in separate branches/worktrees when working concurrently.

Next add `installs.apply()` for the selected template, report its actual result, and recover the same install by project after an interrupted request. Native runs, artifact links, partner configuration, and private playbook reuse follow on the same SDK path. Avoid a parallel single-agent provisioning path unless the template path has a demonstrated gap.

## Retry, budget, and stop behavior

- Use one stable project/operation ID and stable operation-specific idempotency keys across retries, with the same request body. The SDK's default is a fresh UUID per write; supply a deliberate key factory or a documented per-call key. Preserve an interrupted operation ID so it can be recovered after refresh.
- A timeout is an uncertain outcome. Read back the install/session and its report before retrying or declaring failure; do not create a new project to retry the same spawn. Native revision checks protect updates; verify their behavior against the pinned types and mocked responses.
- Keep real cost in the SDK's integer micro-USD, including computer costs. Convert only for display. The existing demo's cents-based $1,000 pool is sample data, not a real credit balance.
- Funding in this MVP means adjusting Naïve spending limits within existing credits, not moving cash. Use native controls initially. Agent period caps, session caps, organization balance, and lifetime portfolio allocations have different meanings; do not claim a synthetic lifetime limit is enforced.
- `sessions.cancel()` stops a particular session, preserves history, and does not remove apps, files, schedules, or inboxes. Read back terminal status/cost, including cancellation/completion races. Do not label a single cancelled session as a fully shut-down company.
- Full template removal has stricter authorization: `apps.installs.remove()` requires the owner's own sign-in and rejects API keys. Use Naïve's native operator surface for full shutdown until the supported operator-auth flow is deliberately implemented. No custom cleanup engine in the first milestone.

Sources: [SDK sessions](https://usenaive.ai/docs/sdk/sessions), [SDK credits](https://usenaive.ai/docs/sdk/credits), [budgets](https://usenaive.ai/docs/concepts/budgets), [SDK agents](https://usenaive.ai/docs/sdk/agents).

## Configuration and validation

Initial configuration: `NAIVE_API_KEY` and optional `NAIVE_API_BASE_URL` (documented control-plane origin: `https://api.vetta.sh`). Keep any dashboard authentication secret server-side. Native catalog templates define their own model/team settings; do not require an extra model or database provider for the catalog/preview milestone.

Later provider configuration may require `MONID_API_KEY`, `AGENTMAIL_API_KEY`, and `MOBILERUN_API_KEY`, or their documented connection/OAuth equivalents. These names are placeholders until each adapter's authentication is verified. Do not paste secrets into reviews or commit them.

Run `pnpm check` for implementation. Acceptance: the installed SDK types compile, mocked transport proves the expected SDK calls, credentials stay server-side, pagination/errors are handled, and the existing demo still works without keys. A live end-to-end run is separate validation once access and actual spending limits are configured.
