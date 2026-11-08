# Monid in AutoFoundry

Monid supplies sources for Scout and can later help Creator discover tools that can deliver an offer. It is a data/tool provider, while Naïve remains the runtime and Foundry remains the ledger. This implements a bounded local source path for #11/#13; no second Foundry service is introduced.

## Verified November 7

- An API key saved locally as `MONID_API_KEY` authenticated to the REST catalog and the Streamable HTTP MCP server at `https://mcp.monid.ai/v1`.
- The live MCP tool names include `monid_discover`, `monid_inspect`, `monid_run`, `monid_get_run` and `monid_balance`. Under a Naïve MCP server named `monid`, these would be `monid.monid_discover`, etc. Authentication from a **hosted Naïve session** has not yet been tested.
- `twitterdata.io` `/tweets/search` is a GET endpoint with `input.queryParams: {query, limit, cursor?}`. Its inspected price is `PER_CALL`, USD **0.00025 = 250 micro-USD**, regardless of result count. Current pricing uses `price.amount.value` and `price.amount.currency`, not the older flat number in some documentation examples.
- Run `01M6W6Q5YBV67JKB8HGN5R0F2V` returned HTTP 200 and zero posts for a complex query. Run `01M6W6TS675RJ1BCA6K6AR6M10` returned HTTP 200 and ten posts for `need a website`. Each receipt reports `billing.reportedCost: {value: 250, unit: MICRO_DOLLAR, currency: USD}`. These are posts to qualify, not ten leads. Upstream HTTP status and result content are checked separately from run completion.

## Local workflow

Create a key at [Monid API keys](https://app.monid.ai/access/api-keys) and save it in the ignored `.env.local` file. Keep it out of chat, command arguments and Git.

```sh
pnpm monid check
pnpm monid discover --query "twitter keyword search"
pnpm monid inspect --provider twitterdata.io --endpoint /tweets/search
pnpm monid search-posts --query "need a website"
# If a run is asynchronous, collect the returned run ID without starting another paid call:
pnpm monid result --run RUN_ID

pnpm scout run --query "Qualify business demand; exclude consumers and seller ads" --source var/scout/monid/RUN_ID.json
pnpm scout status
pnpm scout collect
```

`search-posts` has no provider or endpoint override. It re-inspects the fixed read endpoint, refuses a changed identity/method/price or per-result pricing, limits results to 10, and sends Monid `maxCost: 250 / 1000000` (USD). It makes one execution request and never automatically retries it. If its response is lost, inspect Monid run history before starting a new paid request. Discovery/inspection are free. The local helper does not enforce an aggregate Monid wallet/day budget; it is not invoked by the current cron.

Receipts live under `var/scout/monid/`, ignored by Git. Scout accepts only a completed HTTP-success receipt from that fixed endpoint. It passes a compact representation of at most ten posts to the managed agent, retaining IDs, source URLs, timestamps and billing. Media is removed, text beyond 2,000 characters is marked truncated, and the original receipt remains available. Scout must verify business relevance and a public contact route; noisy, consumer, seller-ad and unverified posts are discarded. Source text is untrusted, not an instruction or permission to act.

## Native scheduled source: handoff to Felix

The current [contract](foundry-contract.md) defines `foundry.add_leads` but no source-execution tool. For unattended Monid reads, the next shared interface should expose a narrowly scoped read operation from Felix's existing app, backed by `scripts/monid-client.ts`'s fixed `searchPosts` helper, and enforce its aggregate Monid spending policy server-side. This is a proposal for contract review, not an implemented MCP endpoint.

Do not grant Scout generic `monid_run`: Monid's catalog also executes write and provisioning endpoints, while Scout's scope is research only. A narrow Foundry source tool can keep the secret server-side, enforce endpoint and spending limits, preserve provider run receipts, and return compact source observations. The generic API/MCP credential, live connector/auth check and fixed-source helper are ready for that integration. Creator's future catalog discovery can be read-only; offer approval must precede any new execution capability.

References: [MCP setup](https://docs.monid.ai/guide/quickstart-mcp.html), [API discovery](https://docs.monid.ai/api/discover.html), [execution and provider status](https://docs.monid.ai/api/run.html), [pricing](https://docs.monid.ai/guide/pricing.html). Use live inspection for actual schemas and prices.
