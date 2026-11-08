# Foundry App (#10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Next.js starter into the deployed `foundry` fullstack Naïve app: the contract's tables, an MCP endpoint at `/mcp`, and the ten foundry tools #10 owns.

**Architecture:** The tools are plain async functions over a small `Db` interface (`query`, `tx`). Production backs `Db` with the `postgres` driver on `DATABASE_URL`; tests back it with PGlite, an in-memory Postgres, loaded from the same migration file. A hand-written JSON-RPC handler serves MCP (`initialize`, `ping`, `tools/list`, `tools/call`) from a Next.js route, and zod schemas give both input validation and each tool's `inputSchema`.

**Tech Stack:** Next.js 16 route handlers, TypeScript, `postgres` (driver), `zod` v4 (`z.toJSONSchema`), `@electric-sql/pglite` (tests only), `@usenaive-sdk/managed-agents` 0.12.3 (spend sync), `node --test` with `tsx`.

**Spec:** [docs/foundry-contract.md](../../foundry-contract.md), sections 2, 3 and 5. Issue: #10.

## Global Constraints

- Node 24, pnpm 11.25.0. `pnpm check` (lint, typecheck, test, build) must pass before the PR.
- Money: costs and budgets are integer micro-dollars (`*_micro_usd`); payments are integer cents (`*_cents`). Never mixed in one field.
- Ids: `cl_` clusters, `of_` offers, `co_` companies, `ld_` leads, `tc_` touches, `py_` payments, `dc_` decisions.
- Tool results stay under 8,000 characters. Listing tools take `limit`, default 20, maximum 50.
- Tool failures return `{ "error": { "code", "message" } }` with MCP `isError: true`, never a JSON-RPC transport error. Codes: `not_found`, `invalid`, `conflict`, `not_approved`, `policy`, `killed`, `naive_error`.
- `/mcp` rejects any request whose `Authorization: Bearer` doesn't match `VETTA_MCP_TOKEN`. If `VETTA_MCP_TOKEN` is unset, it rejects every request.
- Runnable channels today: `contact_form`, `email`. `x_reply` is added only once #13 makes X work.
- Lead status only moves forward: `new` → `assigned` → `contacted` → `replied` → `paid`. `dead` is terminal.
- Keep credentials server-side. Nothing reads or prints `VETTA_MCP_TOKEN`, `DATABASE_URL` or `NAIVE_API_KEY` values.
- Out of scope: `spawn`, `fund`, `kill` (#16), `checkout_link` and payment webhooks (#15), the dashboard UI (#14).

## Review Focus

1. **The same business found twice:** `add_leads` with a lead whose `external_id` (or, when that's missing, `url`) already exists in the cluster counts it as skipped and doesn't duplicate it. A lead with neither is skipped too. Test in Task 3.
2. **A request without the right token:** a missing, wrong or empty bearer, or an unset `VETTA_MCP_TOKEN`, gets HTTP 401 and runs no tool. Test in Task 2.
3. **Unknown ids from an agent:** a `company_id`, `lead_id`, `cluster_id` or `offer_id` that doesn't exist returns a `not_found` tool error, not a 500. Tests in Tasks 3 and 4.
4. **A killed company's agents still talking:** `log_touch` on a killed company returns `killed` and writes nothing. Test in Task 3.
5. **Naïve unreachable or no app key yet:** `get_metrics` still answers from the last snapshots and says `spend_stale: true`. Test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0001_foundry.sql` | Every table in contract section 3, plus the seeded `funding_policy` row |
| `src/lib/server/db.ts` | `Db` interface and `createPgDb(url)` |
| `src/lib/server/ids.ts` | `newId(prefix)` |
| `src/lib/server/foundry/tool.ts` | `defineTool`, `ToolError`, `ToolContext` |
| `src/lib/server/foundry/leads.ts` | `add_leads`, `list_clusters`, `find_lead`, `log_touch` |
| `src/lib/server/foundry/review.ts` | `list_pending`, `review`, `propose_offer`, `log_decision` |
| `src/lib/server/foundry/metrics.ts` | `get_metrics`, `get_company`, `syncSpend` |
| `src/lib/server/foundry/index.ts` | `foundryTools` |
| `src/lib/server/naive.ts` | `createSpendSource(env)` over the SDK |
| `src/lib/server/mcp/protocol.ts` | `handleRpc`, the JSON-RPC handler |
| `src/app/mcp/route.ts` | The HTTP route |
| `tests/helpers/test-db.ts` | `createTestDb()` on PGlite |
| `tests/foundry-*.test.ts`, `tests/mcp-protocol.test.ts` | Tests |

---

### Task 1: Schema, database access and ids

**Files:**
- Create: `migrations/0001_foundry.sql`, `src/lib/server/db.ts`, `src/lib/server/ids.ts`, `tests/helpers/test-db.ts`, `tests/foundry-schema.test.ts`
- Modify: `package.json` (add `postgres`, `zod` to dependencies; `@electric-sql/pglite` to devDependencies)

**Interfaces:**
- Produces:
  - `type Db = { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; tx<T>(fn: (db: Db) => Promise<T>): Promise<T> }`
  - `createPgDb(url: string): Db`, with `prepare: false` (Supabase's pooler) and at most 5 connections
  - `newId(prefix: "cl" | "of" | "co" | "ld" | "tc" | "py" | "dc"): string`, returning `<prefix>_` plus 20 lowercase base32 characters
  - `createTestDb(): Promise<Db>`, a fresh PGlite database with `migrations/0001_foundry.sql` applied

- [ ] **Step 1: Write `tests/foundry-schema.test.ts`**

```ts
test("migration creates every contract table", async () => {
  const db = await createTestDb();
  const rows = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1");
  assert.deepEqual(rows.map((r) => r.table_name), [
    "clusters", "companies", "company_resources", "decisions", "funding_policy",
    "leads", "offers", "payments", "spend", "touches"]);
});

test("funding_policy is seeded with the placeholder limits", async () => {
  const db = await createTestDb();
  const [p] = await db.query("select * from funding_policy");
  assert.equal(Number(p.pool_micro_usd), 10_000_000);   // drivers may return bigint columns as bigint or string
  assert.equal(Number(p.grant_micro_usd), 5_000_000);
  assert.equal(p.max_proposed, 3);
  assert.equal(p.max_active, 2);
  assert.deepEqual(p.budget_split, { builder: 0.5, outreach: 0.3, closer: 0.2 });
});

test("newId uses the prefix and is unique", () => {
  const a = newId("ld"), b = newId("ld");
  assert.match(a, /^ld_[a-z2-7]{20}$/);
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test`
Expected: FAIL, cannot find `tests/helpers/test-db.ts`.

- [ ] **Step 3: Write the migration, `db.ts`, `ids.ts` and `test-db.ts`**

The SQL is contract section 3 verbatim. Drivers may return `bigint` columns as `bigint` or as strings, so tools convert to `number` at the edge with `Number()` (every value stays far below 2^53). `createTestDb` reads the migration with `readFile` and runs it with PGlite's `exec`.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS, including the existing `studio.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add migrations src/lib/server/db.ts src/lib/server/ids.ts tests package.json pnpm-lock.yaml
git commit -m "Add the foundry schema, database access and ids"
```

---

### Task 2: Tool framework and the MCP endpoint

**Files:**
- Create: `src/lib/server/foundry/tool.ts`, `src/lib/server/mcp/protocol.ts`, `src/app/mcp/route.ts`, `tests/mcp-protocol.test.ts`
- Modify: `.env.example` (document `VETTA_MCP_TOKEN` and `DATABASE_URL` as platform-injected)

**Interfaces:**
- Consumes: `Db` (Task 1).
- Produces:
  - `type ToolContext = { db: Db; spend: SpendSource | null; now: () => Date }`, where `SpendSource` comes from Task 5 (declare the type here: `{ listAgentSpend(): Promise<{ agent_id: string; agent_name: string; micro_usd: number }[]> }`)
  - `class ToolError extends Error { constructor(code: ToolErrorCode, message: string) }`, where `ToolErrorCode` is the union in Global Constraints
  - `defineTool<S extends z.ZodObject>(t: { name: string; description: string; input: S; run(ctx: ToolContext, input: z.infer<S>): Promise<unknown> }): Tool`
  - `handleRpc(message: unknown, tools: Tool[], ctx: ToolContext): Promise<object | null>`, which returns `null` for notifications
  - `isAuthorized(header: string | null, token: string | undefined): boolean`, a timing-safe comparison

- [ ] **Step 1: Write `tests/mcp-protocol.test.ts`** with a fake `echo` tool (`input: z.object({ text: z.string() })`) and a `boom` tool that throws `new ToolError("not_found", "no such lead")`:

```ts
test("initialize answers the client's protocol version when supported", ...)
  // params.protocolVersion "2025-06-18" → result.protocolVersion "2025-06-18",
  // capabilities { tools: {} }, serverInfo.name "foundry"
test("initialize falls back to 2025-06-18 for an unknown version", ...)
test("notifications/initialized returns null", ...)
test("tools/list returns name, description and a JSON Schema inputSchema", ...)
  // echo's inputSchema.properties.text.type === "string", required ["text"]
test("tools/call returns the result as JSON text content", ...)
  // content[0].text parses to the tool's return value; isError absent
test("tools/call with invalid arguments returns isError with code invalid", ...)
test("a ToolError becomes isError with its code and message", ...)
  // JSON.parse(content[0].text) deepEquals { error: { code: "not_found", message: "no such lead" } }
test("an unknown tool returns isError, not a JSON-RPC error", ...)
test("an unknown method returns JSON-RPC error -32601", ...)
test("isAuthorized rejects a missing, wrong or empty bearer and an unset token", ...)
  // isAuthorized(null, "t") false; ("Bearer x", "t") false; ("Bearer ", "") false;
  // ("Bearer t", undefined) false; ("Bearer t", "t") true
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test`
Expected: FAIL, cannot find `src/lib/server/mcp/protocol.ts`.

- [ ] **Step 3: Implement `tool.ts`, `protocol.ts` and `route.ts`**

Supported protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. `inputSchema` comes from `z.toJSONSchema(input)` with the `$schema` key removed. An unexpected exception inside a tool becomes `isError` with code `naive_error` if it came from the SDK (`ApiError`), otherwise `invalid` with the message, and is logged with `console.error`. The route: `POST` checks `isAuthorized(req.headers.get("authorization"), process.env.VETTA_MCP_TOKEN)` → 401 JSON `{ error: "unauthorized" }` when false; parses the body (400 on bad JSON); returns 202 with no body when `handleRpc` returns `null`, otherwise 200 JSON. `GET` and `DELETE` return 405. `export const dynamic = "force-dynamic"`. The route builds its `ToolContext` once per cold start, from `createPgDb(process.env.DATABASE_URL)` and `createSpendSource(process.env)` (Task 5; until Task 5 lands, pass `spend: null`).

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/foundry/tool.ts src/lib/server/mcp src/app/mcp tests/mcp-protocol.test.ts .env.example
git commit -m "Serve MCP at /mcp behind VETTA_MCP_TOKEN"
```

---

### Task 3: Scout and child tools: `add_leads`, `list_clusters`, `find_lead`, `log_touch`

**Files:**
- Create: `src/lib/server/foundry/leads.ts`, `tests/foundry-leads.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `ToolError`, `ToolContext` (Task 2); `newId` (Task 1).
- Produces: `addLeads`, `listClusters`, `findLead`, `logTouch` (each a `Tool`), with inputs and outputs exactly as contract section 5 shows them.

Decisions the contract leaves open:
- A lead's dedupe key is `external_id`, or `url` when `external_id` is missing; it's stored in `external_id`. A lead with neither is skipped.
- `signal_count` is recomputed as the number of leads in the cluster.
- `unserved_only` means no company with status `spawning`, `proposed` or `active` serves the cluster.
- `log_touch` statuses: `sent` → `contacted`, `reply_received` → `replied`, `sample_delivered` sets `sample_url` and status `assigned` if it was `new`. Use a rank map so status never moves backwards.

- [ ] **Step 1: Write `tests/foundry-leads.test.ts`**

```ts
test("add_leads creates a pending cluster and counts added leads", ...)
  // 2 leads → { added: 2, skipped: 0, signal_count: 2, review_status: "pending" }
test("add_leads skips a lead it has already seen, by external_id or by url", ...)   // Review Focus 1
  // second call with same external_id, plus one with no external_id but a known url,
  // plus one with neither → { added: 0, skipped: 3, signal_count: 2 }
test("add_leads with an existing label updates the cluster instead of making a new one", ...)
test("list_clusters filters by review_status and unserved_only", ...)
  // insert a company with status "active" on cluster A → unserved_only hides A
test("list_clusters caps limit at 50", ...)
test("find_lead matches by email, url or name within one company only", ...)
test("log_touch moves the lead forward and never backwards", ...)
  // reply_received then sent → lead_status stays "replied"
test("log_touch with sample_delivered sets sample_url", ...)
test("log_touch on a killed company returns killed and writes nothing", ...)      // Review Focus 4
test("log_touch with an unknown company or lead returns not_found", ...)          // Review Focus 3
```

Call tools through `tool.run(ctx, tool.input.parse(args))` with `ctx = { db: await createTestDb(), spend: null, now: () => new Date("2026-11-08T08:00:00Z") }`, and assert `ToolError` codes with `assert.rejects(p, { code: "killed" })`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test`
Expected: FAIL, cannot find `src/lib/server/foundry/leads.ts`.

- [ ] **Step 3: Implement the four tools in `leads.ts`**

`add_leads` runs in one `tx`: upsert the cluster on `label` (`on conflict (label) do update set unserved_score = excluded.unserved_score, updated_at = now()`), then insert each lead with `on conflict (cluster_id, external_id) do nothing returning id`.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/foundry/leads.ts tests/foundry-leads.test.ts
git commit -m "Add the Scout and child tools"
```

---

### Task 4: Compliance and Creator tools: `list_pending`, `review`, `propose_offer`, `log_decision`

**Files:**
- Create: `src/lib/server/foundry/review.ts`, `tests/foundry-review.test.ts`

**Interfaces:**
- Consumes: Task 2's framework; `newId`.
- Produces: `listPending`, `review`, `proposeOffer`, `logDecision` (each a `Tool`), shaped as in contract section 5.

Decisions the contract leaves open:
- `review` accepts only items whose `review_status` is `pending`; anything else returns `conflict`. `reason` is required and non-empty.
- `list_pending` gives up to 3 `sample_leads` per cluster: `name`, `url`, `data`.
- `propose_offer` requires `price_cents >= 50` (Stripe's minimum) and an `outreach_message` that contains `{{sample_url}}`, so every message carries the sample link the Closer matches replies on.
- `log_decision` takes `agent: "creator" | "funder"` and `kind: "hold"` only. Spawn, fund and kill write their own decisions in #16.

- [ ] **Step 1: Write `tests/foundry-review.test.ts`**

```ts
test("list_pending returns pending clusters with up to 3 sample leads, and pending offers", ...)
test("review approves a cluster and writes a compliance decision", ...)
  // decisions row: agent "compliance", kind "approve", cluster_id set, reason as given
test("review rejects an offer with a reason", ...)
test("review of an already reviewed item returns conflict", ...)
test("review of an unknown id returns not_found", ...)                            // Review Focus 3
test("propose_offer on a pending or rejected cluster returns not_approved", ...)
test("propose_offer with an unrunnable channel returns invalid", ...)            // "x_reply", "phone"
test("propose_offer without {{sample_url}} in the message returns invalid", ...)
test("propose_offer stores a pending offer", ...)
test("log_decision records a hold", ...)
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test`
Expected: FAIL, cannot find `src/lib/server/foundry/review.ts`.

- [ ] **Step 3: Implement the four tools in `review.ts`**

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/foundry/review.ts tests/foundry-review.test.ts
git commit -m "Add the Compliance and Creator tools"
```

---

### Task 5: Metrics and spend sync: `get_metrics`, `get_company`

**Files:**
- Create: `src/lib/server/foundry/metrics.ts`, `src/lib/server/naive.ts`, `src/lib/server/foundry/index.ts`, `tests/foundry-metrics.test.ts`
- Modify: `src/app/mcp/route.ts` (use `foundryTools` and `createSpendSource`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `getMetrics`, `getCompany` (each a `Tool`), with output shaped exactly like contract section 7, plus a top-level `spend_stale: boolean`
  - `syncSpend(ctx: ToolContext): Promise<{ synced: boolean }>`, which inserts one `spend` row per agent when the newest `synced_at` is older than 5 minutes (or none exists), maps agents to companies through `company_resources` (`kind = 'agent'`), and returns `{ synced: false }` when `ctx.spend` is null or throws
  - `createSpendSource(env: NodeJS.ProcessEnv): SpendSource | null`, which returns null without `NAIVE_API_KEY`; otherwise it pages `client.agents.list()` and calls `client.agents.spend(id)` for each agent, using `spent_micro_usd`
  - `foundryTools: Tool[]`, the ten tools in contract-table order

Decisions the contract leaves open:
- A company's spend is the sum of each of its agents' latest snapshots. Revenue is `sum(amount_cents - refunded_cents)`.
- Funnel: `leads` counts all of the company's leads, `sampled` those with a `sample_url`, `contacted` those whose status is `contacted`, `replied` or `paid`, `replied` those `replied` or `paid`, and `paid` those `paid`.
- `offer_summary` is `"<product>, $<price>"`, with the price formatted from cents (`9900` → `$99`, `9950` → `$99.50`).
- `policy.granted_micro_usd` is the sum of `companies.granted_micro_usd`; `pool_left_micro_usd` is the pool minus that, never below 0.
- `decisions` are newest first, `decisions_limit` default 20, maximum 50.

- [ ] **Step 1: Write `tests/foundry-metrics.test.ts`** with a fixture that inserts one cluster, one approved offer, two companies (one `active`, one `killed`), leads at each status, touches on two channels, one payment, and spend rows:

```ts
test("get_metrics returns the contract's shape and totals", ...)
  // policy.pool_left_micro_usd, totals.revenue_cents, companies[].funnel,
  // touches_by_channel, cost_per_reply_micro_usd (null with no replies)
test("get_metrics with company_id returns only that company", ...)
test("get_metrics with an unknown company_id returns not_found", ...)
test("get_metrics syncs spend through the spend source when stale", ...)
  // fake source returns 2 agents; one maps to a company via company_resources
test("get_metrics answers with spend_stale when the spend source throws", ...)  // Review Focus 5
test("get_metrics doesn't sync again within 5 minutes", ...)
test("get_company returns the offer, leads with touches and payments, and spend", ...)
test("formatting a price: 9900 → $99, 9950 → $99.50", ...)
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test`
Expected: FAIL, cannot find `src/lib/server/foundry/metrics.ts`.

- [ ] **Step 3: Implement `metrics.ts`, `naive.ts`, `index.ts`, and wire the route**

- [ ] **Step 4: Run the whole check**

Run: `pnpm check`
Expected: lint, typecheck, tests and `next build` all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server tests/foundry-metrics.test.ts src/app/mcp/route.ts
git commit -m "Add get_metrics, get_company and the spend sync"
```

---

### Task 6: Deploy, connect and test from a real agent

No new code unless the deploy fails. Each step records its result in the contract's open questions (section 9) or in the PR description.

- [ ] **Step 1: Apply the migration**

Run: `pnpm naive db migrate migrations/0001_foundry.sql --app foundry`
Then: `pnpm naive db tables --app foundry --human`
Expected: the ten tables, and `funding_policy` with one row.

- [ ] **Step 2: Set the MCP path**

Patch app `app_f27yeve1gzgmztexhf9d0wbx62` with `{ "mcp": "/mcp" }` through the Platform MCP tool `apps_patch`, the same way the hour-one checks called `agents_create`. This mints `VETTA_MCP_TOKEN` into the app's environment.
Expected: `naive app secrets app_f27yeve1gzgmztexhf9d0wbx62` lists `VETTA_MCP_TOKEN`.

- [ ] **Step 3: Deploy**

Run: `pnpm naive app deploy app_f27yeve1gzgmztexhf9d0wbx62 .`, then poll `pnpm naive app deployments app_f27yeve1gzgmztexhf9d0wbx62 --limit 1` until the status is `ready` or `error`.
Expected: `ready`. If the build fails on pnpm or Node 24, record the error and retry with the smallest change that fixes it (an `engines` range or a `vercel.json` install command), and note it in the PR.

- [ ] **Step 4: Check the endpoint from outside**

Run: `curl -s -o /dev/null -w "%{http_code}" -X POST <app url>/mcp -d '{}'`
Expected: `401`.

- [ ] **Step 5: Test from a real agent**

Create a throwaway agent `foundry-probe` on `openai/gpt-oss-20b` with a $0.05 cap: `default_config: { permission: deny }`, the `apps` tool enabled with `allowed_apps: [foundry]`, and `foundry.add_leads`, `foundry.list_clusters` and `foundry.get_metrics` set to `allow`. Start one session asking it to add one test lead to a cluster labelled `probe` and then list clusters.
Expected: the session's events show both tool calls succeeding, and `pnpm naive db query "select label, signal_count from clusters" --app foundry` shows `probe | 1`. Then delete the probe rows (`delete from leads where cluster_id in (select id from clusters where label = 'probe'); delete from clusters where label = 'probe'`) and the probe agent.

- [ ] **Step 6: Ask for the app's Naïve key**

Start a session on an agent with the `apps` tool that calls `apps.request_access` for `foundry` with scopes `agents:read`, `agents:write`, `identities:write`, `boards:write` and the spend read scope. This puts a card in front of Felix. Without his approval, `get_metrics` answers with `spend_stale: true` and #16 can't spawn.
Expected: the card appears; record the exact scope names the tool accepted.

- [ ] **Step 7: Record and open the PR**

Update contract section 9: question 2 (Next.js runs on fullstack apps: yes) and question 3 (the app key's scopes). Push the branch and open a PR that closes #10 and gives Mateo the endpoint URL and tool names for #11.
