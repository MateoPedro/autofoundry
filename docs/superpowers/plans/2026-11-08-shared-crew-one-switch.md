# Shared Crew and One-Switch Operation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run AutoFoundry with a fixed crew of seven agents that hand work to each other through board cards. The foundry dashboard gets a Launch and End switch, and a company is database rows rather than its own agents and app.

**Architecture:** The foundry app stays the hub. It records state, creates keyed board cards that wake the next agent, serves samples, caps each company's spend, and runs a five-minute sweep that VC triggers. Only two Naïve schedules exist: Scout every 2 hours and VC every 5 minutes. Launch and End toggle those schedules and the crew's budgets.

**Tech stack:** Next.js App Router, TypeScript, Postgres (PGlite in tests, real Postgres in CI), zod, the `@usenaive-sdk/managed-agents` SDK, and node:test.

**Spec:** `docs/superpowers/specs/2026-11-08-shared-crew-one-switch-design.md`

## Global Constraints

- **The seven agent names, exactly:** `scout`, `compliance`, `creator`, `vc`, `feedback`, `outreach`, `closer`.
- **Units:** money is integer micro-USD (`*_micro_usd`), except payments, which are integer cents (`*_cents`).
- **Two schedules only:**
  - Scout: `0 */2 * * *`, `5 */2 * * *`, `10 */2 * * *` and `15 */2 * * *` (`maps`, `reviews`, `appstore`, `jobs`).
  - VC: `*/5 * * * *`.
  - Both are `loose`, UTC, and created disabled. Launch enables them.
- **Daily budgets (`cap_micro_usd` / `max_task_micro_usd`):**

  | Agent | Cap | Task |
  |---|---|---|
  | scout | 15,000,000 | 500,000 |
  | compliance | 3,000,000 | 500,000 |
  | creator | 2,000,000 | 500,000 |
  | vc | 15,000,000 | 500,000 |
  | feedback | 2,000,000 | 500,000 |
  | outreach | 5,000,000 | 300,000 |
  | closer | 5,000,000 | 300,000 |

- **Samples:** `SAMPLE_LEADS = 5` leads per company before funding, and each extra grant adds the next 5.
- **`funding_policy` stays as it is:** $5 grants, a $10 pool, `max_proposed` 3, `max_active` 2, 3 grants per company. Its `budget_split` column is no longer read.
- **Samples are served at `<FOUNDRY_URL>/s/<lead_id>`.** `FOUNDRY_URL` is an app secret, for example `https://foundry-p2jr2103s9ve.vercel.app`.
- **The shared inbox is `hello@<system domain>`** on identity `autofoundry`, owned by `closer`. Email is plain text: `to`, `subject`, `text`.
- **Every card title carries the ids the agent needs** (`ld_…`, `co_…`, `cl_…`, `inb_…`), because agents may not get board tools.
- **No message is signed with a person's name or says a person wrote it.** The Closer says it's an AI assistant if asked. There's no AI disclosure line.
- **The app's Naïve key keeps its scopes:** `agents:read`, `agents:write`, `billing:read`. No `sessions:write`.
- **Write the plan's code in the repo's style,** and run `pnpm check` before every commit.

## Review Focus

Each item has a test in the task that owns it:

1. **An event and the sweep both create the same card.** Card keys must dedupe across both paths and across retries. Tested in Task 1 and Task 8.
2. **A Stripe event or a Scout ping arrives while the company is stopped.** The data is recorded and no card is created; Launch's sweep creates the card later. Tested in Task 6 and Task 8.
3. **A company over its grant still gets Outreach work, or a Deliver card is wrongly blocked by the grant.** Tested in Task 7.
4. **An email to the shared inbox matches no lead** (spam, an auto-reply, a stranger). It's dismissed once and never re-sent to the Closer by the sweep. Tested in Task 6 and Task 8.
5. **Naïve answers 429 or fails partway through End.** The state still reads stopped, so every write tool refuses, and End reports which agents and schedules it couldn't change. Tested in Task 9.

---

### Task 1: State, crew registry and keyed work cards

**Files:**
- Create: `migrations/0009_shared_crew.sql`
- Create: `src/lib/server/foundry/roles.ts`
- Create: `src/lib/server/foundry/state.ts`
- Create: `src/lib/server/foundry/work.ts`
- Modify: `src/lib/server/foundry/tool.ts`: `setCardStatus` status becomes `"todo" | "done"`
- Modify: `src/lib/server/naive.ts`, `tests/helpers/fake-naive.ts`: support `"done"`
- Modify: `tests/foundry-schema.test.ts`: the table list
- Create: `tests/helpers/crew.ts`
- Test: `tests/foundry-work.test.ts`

**Interfaces.** Produces:
- **The migration:**
  - `foundry_state(id int pk check (id = 1), running boolean not null default false, changed_at timestamptz not null default now())`, with one row inserted
  - `crew(role text pk, agent_id text not null, board_id text not null, identity_id text, inbox_id text, inbox_address text)`
  - `work_cards(key text pk, role text not null, company_id text references companies(id), board_id text not null, card_id text not null, title text not null, status text not null default 'open', created_at timestamptz not null default now(), closed_at timestamptz)`
  - `session_spend(session_id text pk, agent_name text not null, company_id text references companies(id), micro_usd bigint not null, started_at timestamptz not null, synced_at timestamptz not null default now())`
  - `inbound_seen(message_id text pk, outcome text not null, at timestamptz not null default now())`
  - `alter table touches add column message_id text`, plus a partial index on `message_id`
- **`roles.ts`:** `CREW_ROLES` (the seven names), `type CrewRole`, `ROLE_BUDGETS: Record<CrewRole, { cap_micro_usd: number; max_task_micro_usd: number }>` (values from Global Constraints), and `SAMPLE_LEADS = 5`.
- **`state.ts`:**
  - `isRunning(db: Db): Promise<boolean>`
  - `setRunning(db: Db, running: boolean, at: Date): Promise<void>`
  - `stateOf(db: Db): Promise<{ running: boolean; changed_at: string }>`
- **`work.ts`:**
  - `type Work = { role: CrewRole; key: string; title: string; body: string; companyId: string | null; billable: boolean }`
  - `WORK`, an object of builders that each return a `Work`. Key and title for each:

    | Builder | Key | Title |
    |---|---|---|
    | `screen(cycleStart: Date)` | `compliance:screen:<iso>` | `Screen Scout batch <iso>` |
    | `design(clusterId)` | `creator:design:<cl>` | `Design a company for cluster <cl>` |
    | `sample(companyId, grant: number)` | `creator:sample:<co>:<grant>` | `Sample new leads for <co>` |
    | `revise(clusterId, companyId)` | `creator:revise:<co>` | `Revise the offer for cluster <cl> after <co> was killed` |
    | `sibling(companyId)` | `creator:sibling:<co>` | `Consider a sibling of <co>` |
    | `contact(leadId, companyId)` | `outreach:contact:<ld>` | `Contact <ld> for <co>` |
    | `followUp(leadId, companyId)` | `outreach:followup:<ld>` | `Follow up <ld> for <co>` |
    | `deliver(leadId, companyId)` | `closer:deliver:<ld>` | `Deliver <ld> for <co>` |
    | `inbound(messageId, from)` | `closer:inbound:<inb>` | `Answer email <inb> from <from>` |
    | `feedback(decisionId)` | `feedback:<dc>` | `Write feedback through <dc>` |

    `billable` is true for `contact`, `followUp` and `sample`, and false for the rest.
  - `crewMember(db: Db, role: CrewRole): Promise<{ agent_id: string; board_id: string; identity_id: string | null; inbox_id: string | null; inbox_address: string | null }>`. It throws `ToolError("internal", "the crew isn't set up; run pnpm crew setup")` when the row is missing.
  - `wake(ctx: ToolContext, work: Work): Promise<{ created: boolean; reason?: "stopped" | "exists" | "over_grant" }>`. It creates the card on the role's own board (`crew.board_id`), assigned to the role's agent name, with `key` = `work.key`, and records it in `work_cards`. It does nothing when the company is stopped or the key exists. `over_grant` is added in Task 7.
  - `closeCompanyWork(ctx: ToolContext, companyId: string): Promise<number>` sets the company's open cards to `done` and marks them `closed`.
- **`tests/helpers/crew.ts`:** `seedCrew(ctx: ToolContext & { naive: FakeNaive }): Promise<void>` creates the seven agents in the fake, with nonzero budgets and a board each, and inserts the seven `crew` rows. The `closer` row gets identity `idn_crew` and inbox `eml_crew`, at `hello@auto-foundry-03s9ve.usenaive.ai`. Every later task's tests use it.

- [ ] **Step 1: Write the failing tests** in `tests/foundry-work.test.ts`, using `seedCrew`.
  - `wake creates one card per key, on the role's board, assigned to the role`: calling `wake(ctx, WORK.contact("ld_1", "co_1"))` twice gives `[{ created: true }, { created: false, reason: "exists" }]`. `naive.cards` has length 1, with title `"Contact ld_1 for co_1"`, assignee `"outreach"` and key `"outreach:contact:ld_1"`.
  - `wake does nothing while stopped`: after `setRunning(db, false, NOW)`, the result is `{ created: false, reason: "stopped" }`, `naive.calls` doesn't include `"createCard"`, and `work_cards` is empty.
  - `closeCompanyWork closes only that company's open cards`: with two cards for `co_1` and one for `co_2`, the result is 2. Those two cards have `status` `"done"` in the fake, and the `co_2` card is still `"todo"`.
  - `crewMember explains a missing crew`: the call rejects with code `"internal"` and a message matching `/pnpm crew setup/`.
- [ ] **Step 2: Run** `node --import tsx --test tests/foundry-work.test.ts`. Expected: it fails because `work.ts` doesn't exist.
- [ ] **Step 3: Implement** the migration, `roles.ts`, `state.ts` and `work.ts`, and the `"done"` status in `tool.ts`, `naive.ts` and the fake. `testContext` seeds `foundry_state.running = true` so existing tests are unaffected. Add `crew`, `foundry_state`, `inbound_seen`, `session_spend` and `work_cards` to the schema test's table list.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git commit -m "Add the foundry state, crew registry and keyed work cards"`

### Task 2: Writing tools refuse while stopped

**Files:**
- Modify: `src/lib/server/foundry/tool.ts`: `ToolErrorCode` gains `"stopped"`, and `Tool`/`defineTool` gain `writes: boolean`
- Modify: every tool definition in `src/lib/server/foundry/*.ts`, setting `writes`
- Modify: `src/lib/server/mcp/protocol.ts`: `callTool` checks `isRunning` before running a tool whose `writes` is true
- Test: `tests/mcp-protocol.test.ts`

**Interfaces:**
- **Consumes:** `isRunning`, from Task 1.
- **Produces:** `Tool.writes`. Tools with `writes: true`:
  - `add_leads`, `monid_read`
  - `screen_batch`, `submit_screen`, `review`
  - `propose_offer`, `spawn`, `fund`, `kill`, `log_decision`
  - `log_touch`, `publish_sample`, `checkout_link`
  - `write_feedback`, `compact_feedback`
  - `reconcile` (Task 8), `dismiss_inbound` (Task 6)

  All other tools are `false`.

- [ ] **Step 1: Write the failing tests:**
  - `a writing tool answers stopped while the company is stopped`: with the state stopped, calling `log_decision` through `handleRpc` gives `isError` true and `error.code === "stopped"`, and the `decisions` table is still empty.
  - `reading tools still work while stopped`: `get_metrics` returns a normal result.
  - `every tool says whether it writes`: `foundryTools.filter((t) => t.writes).map((t) => t.name).sort()` equals the list above, minus the tools Tasks 6 and 8 add.
- [ ] **Step 2: Run** `node --import tsx --test tests/mcp-protocol.test.ts`. Expected: it fails because `code` is undefined and `writes` is missing.
- [ ] **Step 3: Implement.** The refusal message is `"the company is stopped; the owner turns it back on with Launch"`.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git commit -m "Refuse writing tools while the company is stopped"`

### Task 3: Seven agent configs, with budgets from one source

**Files:**
- Create: `agents/outreach.agent.yaml`, `agents/closer.agent.yaml`, `agents/prompts/outreach.md`, `agents/prompts/closer.md`
- Modify: `agents/vc.agent.yaml` (budget), `agents/creator.agent.yaml` (adds `foundry.publish_sample` and `web_fetch`)
- Modify: `scripts/parent-config.ts`, `scripts/parent.ts`
- Delete: `templates/child/`, `src/lib/server/foundry/templates.ts`, `tests/child-templates.test.ts`, `tests/fixtures/child/`, and `childTemplate` (from `ToolContext`, `context.ts`, `src/lib/server/dashboard.ts` and `tests/helpers/fixtures.ts`)
- Test: `tests/parent.test.ts`

**Interfaces:**
- **Consumes:** `ROLE_BUDGETS`, from Task 1.
- **Produces:**
  - `PARENTS` gains `outreach` and `closer`. Each entry gets `foundryTools: string[]`, `extraTools: Record<string, object>` (non-foundry tool configs) and `cron: string | null`.
  - **`creator`:**
    - foundry tools: `list_clusters`, `list_offers`, `review_context`, `propose_offer`, `spawn`, `publish_sample`, `log_decision`, `get_metrics`, `get_company`
    - extra tools: `web_fetch`
  - **`vc`:** adds the foundry tool `reconcile`, and its cron is `*/5 * * * *`.
  - **`feedback`:** unchanged tools, and its cron is `null`.
  - **`outreach`:**
    - foundry tools: `find_lead`, `get_company`, `log_touch`
    - extra tools: `email.inboxes`, `email.send`, and `browser` with `{ allow_writes: true }`
    - window `loose`
  - **`closer`:**
    - foundry tools: `find_lead`, `get_company`, `log_touch`, `checkout_link`, `publish_sample`, `dismiss_inbound`
    - extra tools: `email.inboxes`, `email.send`
    - window `immediate`
    - no `email.read`
  - `loadParent` requires each yaml's `budget` to equal `ROLE_BUDGETS[role]` with period `day`.
  - `pnpm parent <role> deploy` refuses a role whose `cron` is `null`.
  - **Prompts:**
    - `agents/prompts/outreach.md` and `closer.md` are adapted from the deleted `templates/child/prompts`. Ids come from the card title and the offer from `foundry.get_company`, and there are no `{{…}}` placeholders.
    - The Closer passes `message_id` (the `inb_…` from its wake message) to `log_touch`, and calls `foundry.dismiss_inbound` for mail that matches no lead.
    - Both find the shared inbox's id with `email.inboxes`.

- [ ] **Step 1: Write the failing tests** in `tests/parent.test.ts`:
  - `every role's yaml budget matches ROLE_BUDGETS`: for each of the seven roles, parse `agents/<role>.agent.yaml` and check that `budget` equals `{ ...ROLE_BUDGETS[role], period: "day" }`.
  - `outreach and closer load with exactly their tools`: `loadParent("closer", "app_x")` gives tool config keys equal to the foundry tools plus `email.inboxes`, `email.send` and `apps`. It contains no `email.read`, and its `window` is `"immediate"`.
  - `only vc has a schedule`: `Object.entries(PARENTS).filter(([, s]) => s.cron)` equals `[["vc", …]]` with cron `"*/5 * * * *"`.
  - `crew prompts carry no template placeholders`: `agents/prompts/outreach.md` and `closer.md` don't match `/\{\{\w+\}\}/`.
- [ ] **Step 2: Run** `node --import tsx --test tests/parent.test.ts`. Expected: it fails because the outreach yaml is missing and the VC budget is 2,000,000.
- [ ] **Step 3: Implement** the configs, prompts and loader changes, then delete the per-company template code.
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Define the seven-agent crew and drop the per-company templates"`

### Task 4: `spawn` writes rows, `publish_sample` stores, and the foundry serves samples

**Files:**
- Modify: `src/lib/server/foundry/company.ts`: `spawn`. Delete `build`, `crewTeam`, `placeholderPage`, `agentsOf`, `deploymentsOf` and `loadTemplate`.
- Modify: `src/lib/server/foundry/crew.ts`: `publish_sample`. Delete the `follow_ups_due` tool.
- Modify: `src/lib/server/foundry/tool.ts` and `src/lib/server/context.ts`: `ToolContext.appUrl: string`, from `FOUNDRY_URL`
- Create: `src/app/s/[lead]/route.ts`
- Modify: `agents/prompts/creator.md`: the wake titles from Task 1, a 5-lead `spawn`, and the sample rules moved from the deleted builder prompt
- Test: `tests/foundry-spawn.test.ts`, `tests/foundry-crew.test.ts` (both rewritten), `tests/sample-route.test.ts`

**Interfaces:**
- **Consumes:** `SAMPLE_LEADS`, `wake` and `WORK.contact`, from Task 1.
- **Produces:**
  - **`spawn`** takes `{ request_id, offer_id, parent_id?, reason }` (no `lead_count`) and returns `{ company_id, slug, status: "spawning", lead_ids: string[] }`. It assigns the oldest `SAMPLE_LEADS` unassigned `new` leads of the offer's cluster and makes no Naïve call. `max_proposed` counts `spawning` and `proposed` companies, as today.
  - **`publish_sample`** takes `{ company_id, lead_id, agent_name, html }`. It works for `spawning`, `proposed` and `active` companies and refuses `killed` ones.
    - It sets `sample_url` to `` `${ctx.appUrl}/s/${lead_id}` `` and logs a `sample_delivered` touch.
    - When every assigned lead of a `spawning` company has a sample, the company becomes `proposed`.
    - On an `active` company, it wakes `WORK.contact` for that lead the first time.
  - **`GET /s/<lead_id>`** serves the stored HTML with `content-type: text/html; charset=utf-8` and `content-security-policy: default-src 'none'; img-src https: data:; style-src 'unsafe-inline'`. It answers 404 when the lead has no sample.

- [ ] **Step 1: Write the failing tests:**
  - `spawn opens a company from rows only`: with 7 leads in the cluster, `spawn` returns 5 `lead_ids` (the oldest), status `"spawning"`, and `naive.calls` equal to `[]`.
  - `spawn still refuses past max_proposed and on a reused request_id`: the codes are `"policy"` and `"conflict"`.
  - `the company is proposed once its last sample is published`: after 4 of 5 publishes the status is `"spawning"`, and after the 5th it's `"proposed"`.
  - `publish_sample stores the page and points at the foundry`: `sample_url === "https://foundry.test/s/" + leadId` (the test context sets `appUrl` to `"https://foundry.test"`). Publishing again replaces the HTML and keeps one `samples` row.
  - `publish_sample on an active company wakes Outreach once`: publishing twice for a newly assigned lead on an `active` company gives one card titled `` `Contact ${leadId} for ${companyId}` ``.
  - `publish_sample refuses a killed company`: the code is `"killed"`.
  - In `tests/sample-route.test.ts`, `the sample route serves stored HTML under a strict policy, and 404s otherwise`.
- [ ] **Step 2: Run** them. Expected: they fail.
- [ ] **Step 3: Implement.** Set `FOUNDRY_URL` in `.env.example`.
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Spawn companies as rows and serve samples from the foundry"`

### Task 5: `fund` and `kill` work on records and hand off work

**Files:**
- Modify: `src/lib/server/foundry/company.ts`: `fund` and `kill`. Delete `resumeParkedCards`.
- Modify: `agents/prompts/vc.md`: kill a proposed company it decides not to fund, with the reason
- Modify: `agents/prompts/feedback.md`: woken by a `Write feedback through dc_…` card
- Test: `tests/foundry-fund.test.ts` (rewritten)

**Interfaces:**
- **Consumes:** `wake`, `WORK.contact`, `WORK.sample`, `WORK.revise`, `WORK.feedback` and `closeCompanyWork`, from Task 1, and `SAMPLE_LEADS`.
- **Produces:**
  - **`fund`** keeps today's input and policy refusals.
    - On a first grant, it makes the company `active` and wakes `WORK.contact` for each sampled lead that has no `sent` touch.
    - On a 2nd or 3rd grant, it assigns the next `SAMPLE_LEADS` unassigned `new` leads of the cluster and wakes `WORK.sample(company, n)`.
    - In both cases it wakes `WORK.feedback(decision)`.
    - It returns `{ company_id, status, granted_micro_usd, pool_left_micro_usd, leads_added, work_created }`.
    - It makes no `setBudget` call.
  - **`kill`** marks the company `killed` with `killed_at`, closes its work, writes the decision, and wakes `WORK.feedback`. If the cluster still has unassigned `new` leads, it also wakes `WORK.revise(cluster, company)`. It returns `{ company_id, status: "killed", cards_closed }`.

- [ ] **Step 1: Write the failing tests:**
  - `a first grant activates the company and hands each sampled lead to Outreach`: there are 5 Outreach cards, and the first grant has no `setBudget` in `naive.calls`.
  - `a second grant adds the next 5 leads and wakes Creator to sample them`: `leads_added === 5`, and a card titled `` `Sample new leads for ${co}` `` exists.
  - `fund still refuses past the pool, the grant count and max_active`: the codes are `"policy"`.
  - `kill closes the company's cards and wakes Feedback, and Creator only if leads remain`.
  - `fund and kill wake Feedback with the decision id`: the card title matches `/^Write feedback through dc_/`.
- [ ] **Step 2: Run** them. Expected: they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Fund and kill companies as records and hand off their work"`

### Task 6: Event hand-offs, the shared inbox, and Deliver

**Files:**
- Modify: `src/lib/server/foundry/cycle.ts`: `recordScoutIdle(ctx, now)` wakes `WORK.screen` when the cycle reaches `RUNS_PER_CYCLE` pings
- Modify: `src/app/api/scout-idle/route.ts`: uses `appContext()`
- Modify: `src/lib/server/foundry/screen.ts`: `submit_screen` calls `fillCreatorQueue`
- Modify: `src/lib/server/foundry/work.ts`: adds `fillCreatorQueue`
- Modify: `src/lib/server/foundry/payments.ts`: the Deliver card becomes `WORK.deliver` for the shared Closer, and a company's first payment also wakes `WORK.sibling`
- Modify: `src/lib/server/foundry/leads.ts`:
  - `find_lead` makes `company_id` optional and returns `company_id` on each lead
  - `log_touch` gains an optional `message_id`
  - a new `dismiss_inbound` tool
- Test: `tests/foundry-screen.test.ts`, `tests/foundry-payments.test.ts`, `tests/foundry-leads.test.ts`

**Interfaces:**
- **Consumes:** Task 1's `wake` and `WORK`.
- **Produces:**
  - **`fillCreatorQueue(ctx: ToolContext): Promise<number>`** wakes `WORK.design` for the oldest approved clusters that have unassigned `new` leads, no live company (`spawning`, `proposed` or `active`) and no open design card. It wakes at most `max_proposed` minus (waiting companies plus open design cards).
  - **`dismiss_inbound`** takes `{ message_id: string, reason: string }`, inserts an `inbound_seen` row with `outcome = reason`, and is idempotent.
  - **`recordScoutIdle(ctx, now)`** has the new signature. Its callers pass `ctx`.
  - **`log_touch` on a killed company** still accepts `reply_received`, `reply_sent` and `delivered`, so a buyer who pays after a kill is answered and delivered (spec, Money). Every other kind still answers `killed`.
  - **`NaiveWriter` loses the methods nothing calls any more** after Tasks 4–6: `systemDomain`, `createIdentity`, `createApp`, `deployApp`, `findAgent`, `createAgent`, `attachIdentity`, `findInbox`, `createInbox`, `ensureBoard`, `getBudget`, `createDeployment` and `setTeam`. Remove them from `tool.ts`, `naive.ts` and the fake. Grep each name, because TypeScript doesn't flag unused interface members.

- [ ] **Step 1: Write the failing tests:**
  - `the last Scout run of a cycle wakes Compliance once`: after `RUNS_PER_CYCLE` pings there's one card, `Screen Scout batch <cycle iso>`, and a fifth ping doesn't add a second.
  - `a Scout ping while stopped records the ping and wakes nobody`.
  - `submitting a screen hands Creator the queue up to free slots`: with 4 approved clusters, `max_proposed` 3 and 1 waiting company, there are 2 design cards, for the 2 oldest clusters.
  - `a paid checkout wakes the shared Closer, and a company's first payment also wakes Creator for a sibling`: cards titled `` `Deliver ${ld} for ${co}` `` and `` `Consider a sibling of ${co}` ``. A second payment adds neither.
  - `a payment while stopped is recorded and wakes nobody`.
  - `find_lead without company_id finds a lead in any live company and says which`.
  - `log_touch keeps the inbound message id`.
  - `dismiss_inbound marks a message handled once`.
  - `a killed company's buyer can still be answered and delivered`: on a killed company, `log_touch` accepts `delivered`, and `sent` answers `killed`.
- [ ] **Step 2: Run** them. Expected: they fail.
- [ ] **Step 3: Implement,** then remove the unused `NaiveWriter` methods.
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Hand off work on Scout pings, screens and payments through the shared crew"`

### Task 7: Spend per company and the grant limit

**Files:**
- Modify: `src/lib/server/foundry/tool.ts`, `src/lib/server/naive.ts`, `tests/helpers/fake-naive.ts`: add `NaiveWriter.sessionsSince`
- Create: `src/lib/server/foundry/spend.ts`
- Modify: `src/lib/server/foundry/metrics.ts`: company spend from `session_spend`, and the session sync runs with today's spend sync
- Modify: `src/lib/server/foundry/work.ts`: `wake` refuses billable work over the grant
- Test: `tests/foundry-spend.test.ts`

**Interfaces:**
- **Consumes:** Task 1's `wake` and `crewMember`.
- **Produces:**
  - **`NaiveWriter.sessionsSince(agentId: string, since: Date): Promise<{ id: string; created_at: string; consumed_micro_usd: number; first_message: string }[]>`**. `first_message` is the session's first user message, read with `sessions.events(id, { limit: 1 })`, unless the session object already names the card. Verify this against one live card-woken session and record what you found in a code comment.
  - **`companyOfSession(db: Db, firstMessage: string): Promise<string | null>`:**
    - the first `/co_[a-z2-7]{20}/` in the message, if that company exists
    - else the first `/inb_[a-z0-9]+/`, looked up through `touches.message_id`
    - else `null`
  - **`syncSessionSpend(ctx: ToolContext, since: Date): Promise<number>`** upserts a `session_spend` row for each `outreach`, `closer` and `creator` session and returns the count.
  - **`companySpend(db: Db, companyId: string): Promise<number>`** is the sum of that company's `session_spend.micro_usd`.
  - **`wake`** returns `{ created: false, reason: "over_grant" }` for billable work on a company where `companySpend >= granted_micro_usd`.

- [ ] **Step 1: Write the failing tests:**
  - `a session is charged to the company named on its card`.
  - `an inbound session is charged through the message id the Closer logged`.
  - `a session with neither is parent overhead`: `company_id` is null.
  - `a company at its grant gets no new Outreach work, but its Deliver card still goes out`.
  - `get_metrics reports a company's spend from its sessions`.
- [ ] **Step 2: Run** them. Expected: they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Charge shared-crew sessions to companies and stop work at the grant"`

### Task 8: The five-minute sweep (`reconcile`)

**Files:**
- Create: `src/lib/server/foundry/reconcile.ts`
- Modify: `src/lib/server/foundry/tool.ts`, `src/lib/server/naive.ts`, `tests/helpers/fake-naive.ts`: add `NaiveWriter.inboundMessages`
- Modify: `src/lib/server/foundry/index.ts`: register `reconcile` (`writes: true`, VC only)
- Modify: `agents/prompts/vc.md`: call `foundry.reconcile` first on every pass
- Test: `tests/foundry-reconcile.test.ts`

**Interfaces:**
- **Consumes:**
  - Task 1's `wake`, `WORK` and `crewMember`
  - Task 6's `fillCreatorQueue`
  - Task 7's spend gate
  - `cycleStart`, `READY_AFTER_MINUTES` and `RUNS_PER_CYCLE`, from `cycle.ts`
- **Produces:**
  - **`NaiveWriter.inboundMessages(identityId: string, inboxId: string, since: Date): Promise<{ id: string; from: string; received_at: string }[]>`**
  - **`reconcile(ctx: ToolContext): Promise<{ stopped: boolean; created: Record<"design" | "screen" | "contact" | "followUp" | "deliver" | "inbound", number> }>`**
  - **The `reconcile` tool**, which takes no input and returns the same object.
  - **The sweep's rules:**
    - `design`: through `fillCreatorQueue`.
    - `screen`: once a cycle is `READY_AFTER_MINUTES` old, if it has fewer than `RUNS_PER_CYCLE` pings and no screen row.
    - `contact`: for `active` companies' leads that have a sample and no `sent` touch.
    - `followUp`: for leads with exactly one `sent` touch, 20 or more hours old, and status `contacted`.
    - `deliver`: for leads with a payment and no `delivered` touch.
    - `inbound`: for the shared inbox's messages from the last 3 days, older than 10 minutes, with no touch carrying their id and no `inbound_seen` row.

- [ ] **Step 1: Write the failing tests:**
  - One test for each rule, each named for the rule.
  - `a second sweep creates nothing new`.
  - `the sweep does nothing while stopped`.
  - `a dismissed or answered email is never handed out again`.
  - `a lead due a follow-up twenty hours after its first email gets one follow-up card`.
- [ ] **Step 2: Run** them. Expected: they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Add the five-minute sweep that hands out waiting work"`

### Task 9: Launch, End, and the operator gate

**Files:**
- Create: `src/lib/server/foundry/control.ts`
- Create: `src/lib/server/gate.ts`
- Create: `src/app/api/entry/route.ts` and `src/app/api/control/[action]/route.ts`
- Modify: `src/lib/server/foundry/tool.ts`, `src/lib/server/naive.ts`, `tests/helpers/fake-naive.ts`: `NaiveWriter.deploymentsOfAgent` replaces `findDeployment`
- Modify: `src/app/page.tsx` and `src/app/dashboard.tsx`: a public running or stopped line, and operator-only controls
- Modify: `src/lib/server/foundry/activity.ts` and `src/lib/dashboard/view.ts`:
  - The agents panel lists the seven fixed agents. `FOUNDRY_AGENTS` gains `outreach` and `closer`.
  - Outreach's and the Closer's last action comes from `touches` by `agent_name`.
  - The per-company crew rows, read from `company_resources`, go.
- Test: `tests/foundry-control.test.ts`, `tests/gate.test.ts`, `tests/dashboard-agents.test.ts`

**Interfaces:**
- **Consumes:** Task 1's `setRunning`, `stateOf`, `crewMember` and `ROLE_BUDGETS`, and Task 8's `reconcile`.
- **Produces:**
  - **`NaiveWriter.deploymentsOfAgent(agentId: string): Promise<{ id: string; enabled: boolean }[]>`**
  - **`type ControlReport = { running: boolean; budgets: { role: CrewRole; cap_micro_usd: number; ok: boolean }[]; schedules: { id: string; enabled: boolean; ok: boolean }[]; swept: Awaited<ReturnType<typeof reconcile>> | null; errors: string[] }`**
  - **`launch(ctx: ToolContext): Promise<ControlReport>`:**
    1. Set every role's cap to `ROLE_BUDGETS`.
    2. Enable the deployments of `scout` and `vc`.
    3. Move cards that were parked by a zero budget back to `todo`.
    4. `setRunning(true)`.
    5. `reconcile`.
  - **`stop(ctx: ToolContext): Promise<ControlReport>`:**
    1. `setRunning(false)` first.
    2. Disable those deployments.
    3. Set all seven caps to `{ cap_micro_usd: 0, max_task_micro_usd: 0, period: "day" }`.

    Each Naïve call is retried up to 3 times on a 429. A call that still fails goes in `errors`, and End carries on.
  - **`gate.ts`:**
    - `operatorCookieValue(token: string): string`, which is `HMAC-SHA256(token, "foundry-operator")` in hex
    - `isOperator(cookie: string | undefined, token: string | undefined): boolean`, a constant-time comparison
    - `verifyEntryTicket(ticket: string, token: string, now: Date): boolean`
  - **`POST /api/entry`** accepts a form field `ticket` (from the Studio) or `password` (compared with `DASHBOARD_PASSWORD`). It sets the `foundry_operator` cookie (HttpOnly, Secure, SameSite=Lax, 30 days) and redirects to `/`.
  - **`POST /api/control/launch` and `/api/control/stop`** answer 401 without the operator cookie, otherwise the `ControlReport` as JSON.

- [ ] **Step 1: Inspect the entry contract.**
  1. With the owner's CLI login, set a random `DASHBOARD_TOKEN` secret on the foundry app.
  2. Call `apps.entry(app_id)` once and record the shape of `url` and `ticket` in `gate.ts`'s header comment.
  3. If the ticket's signed fields can't be confirmed, implement only the `password` path and leave `verifyEntryTicket` returning false, with a comment saying why.
- [ ] **Step 2: Write the failing tests:**
  - `launch restores the crew's budgets, enables the two schedules, runs the sweep and marks the company running`.
  - `stop marks the company stopped before anything else, disables schedules and zeroes every cap`.
  - `stop reports what Naïve refused but still leaves the company stopped`: the fake fails `setBudget` for `closer`. The state is stopped, `errors` names `closer`, and the other six caps are 0.
  - `the control routes refuse a request without the operator cookie`.
  - `the operator cookie can't be guessed from the URL alone`: `isOperator(undefined, token)` and `isOperator("x", token)` are both false.
  - `the dashboard shows the controls only to an operator`: render `page.tsx`'s controls component with and without the cookie.
  - `the agents panel lists the seven fixed agents and no per-company crew`.
- [ ] **Step 3: Run** them. Expected: they fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 6: Commit:** `git commit -m "Add Launch and End behind the Naïve operator gate"`

### Task 10: Two-hour Scout cycle, crew setup and disabled schedules

**Files:**
- Modify: `scripts/scout-playbooks.ts` and `src/lib/server/foundry/cycle.ts`: `CYCLE_HOURS = 2`
- Modify: `scripts/scout.ts` and `scripts/parent.ts`: `deploy` creates schedules disabled and never enables them
- Modify: `scripts/compliance.ts`: `deploy` refuses in screen mode, because Compliance is woken by cards
- Create: `scripts/crew.ts`, and the `"crew"` script in `package.json`
- Test: `tests/scout-playbooks.test.ts`, `tests/crew-setup.test.ts`

**Interfaces:**
- **Consumes:** `CREW_ROLES`, from Task 1.
- **Produces:**
  - **`pnpm crew setup --foundry-app app_ID`** is idempotent. It:
    1. finds the seven agents by name and refuses if any is missing
    2. ensures identity `autofoundry`, attaches it to `outreach` and `closer`, and ensures inbox `hello@<system domain>` owned by `closer`
    3. ensures each agent's board
    4. upserts the seven `crew` rows through `client.database.query`
    5. sets a random `DASHBOARD_TOKEN` on the app if it's missing, without printing it
  - **`pnpm crew access`** calls `apps.rotateAccess` and prints the dashboard password once, in the owner's own terminal.
  - **`planCrewSetup(existing)`**, the pure planning step, is exported for tests.

- [ ] **Step 1: Write the failing tests:**
  - `a cycle is two hours, with the four playbooks at :00, :05, :10 and :15`: the crons equal `["0 */2 * * *", "5 */2 * * *", "10 */2 * * *", "15 */2 * * *"]`, and `CYCLE_HOURS` in both files is 2.
  - `crew setup plans only what's missing`.
  - `crew setup refuses when an agent is missing`.
  - `deploy bodies are created disabled`.
- [ ] **Step 2: Run** them. Expected: they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check`. Expected: it passes.
- [ ] **Step 5: Commit:** `git commit -m "Run Scout every two hours, set up the shared crew and create schedules off"`

### Task 11: Contract, docs and the rollout runbook

**Files:**
- Modify: `docs/foundry-contract.md`, sections 1, 4, 5 and 7: the shared crew, card hand-offs, the tool table (`reconcile`, `dismiss_inbound`, and the removed `follow_ups_due`), state and spend
- Modify: `docs/scout.md`, `docs/compliance.md`, `docs/creator-vc.md`, `README.md`
- Create: `docs/operations.md`: Launch and End, and the one-time rollout

**Interfaces:**
- **Consumes:** every task's names.
- **Produces:** the rollout steps, in this order:
  1. `pnpm naive db migrate migrations/0009_shared_crew.sql --app foundry`
  2. Set `FOUNDRY_URL` on the app, then redeploy it.
  3. Apply the agents:
     - `pnpm parent <creator|vc|feedback|outreach|closer> apply --foundry-app app_f27yeve1gzgmztexhf9d0wbx62`
     - `pnpm scout apply --foundry-app …`
     - `pnpm compliance apply --mode screen --foundry-app …`
  4. `pnpm crew setup --foundry-app …`
  5. `pnpm scout idle-token`, then redeploy the app.
  6. `pnpm scout deploy` and `pnpm parent vc deploy`, which create the schedules off.
  7. Open the foundry in the Naïve Studio and press Launch.

- [ ] **Step 1: Update the docs** so every tool, table, schedule and command named in them exists after Tasks 1–10.
- [ ] **Step 2: Check the docs against the code:**
  - `grep -rn "follow_ups_due\|templates/child\|co-NN-builder" docs README.md` finds nothing.
  - `pnpm check` passes.
- [ ] **Step 3: Commit:** `git commit -m "Document the shared crew and the Launch/End rollout"`
