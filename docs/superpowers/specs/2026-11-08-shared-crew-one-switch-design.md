# Shared crew and one-switch operation

Date: 2026-11-08. Owner: Felix. Status: draft for the owner's approval.

## Why

- **Per-company crews don't scale.** `spawn` creates three agents, a Naïve app, an identity and an inbox for every company, and `kill` keeps them. Fifty companies would leave about 150 agents and 50 apps in the org.
- **Steps hand off on timers.** Compliance polls, Creator runs hourly, VC would run hourly. An idea takes one to two hours to reach funding, and most scheduled runs find nothing to do.
- **There's no single place to start or stop.** Today, stopping means deleting schedules and zeroing budgets by hand.

## What the owner decided

1. **One place to launch the parent company:** a Launch button on the foundry dashboard. Launching starts scouting.
2. **Every business Scout finds moves through the whole loop until it dies,** either killed by VC or stopped by the owner.
3. **Two timers only:** Scout every 2 hours and VC every 5 minutes. Every other step starts when the step before it finishes.
4. **An End switch** that stops every agent: the parent company and all its companies. Nothing is deleted, and Launch picks up where End stopped.
5. **The buttons work only for people in the owner's Naïve org,** opening the app through the Naïve Studio. The rest of the dashboard stays public.
6. **A company has no agents of its own.** It's records that a fixed crew works on.
7. **Creator writes the offer and builds the free samples.** There is no separate Builder.
8. **Emails keep the current sender,** on Naïve's system domain, with no custom domain or brand for now. There's no AI disclosure line (PR #57). No message claims a person wrote it, and the Closer says it's an AI assistant if asked.
9. **VC checks every 5 minutes,** chosen over event wake-ups. That's about $1.60 to $7 per 12 hours, measured from VC runs on this org.

## Goals

- **A fixed set of seven agents, however many companies there are:** Scout, Compliance, Creator, VC, Outreach, Closer and Feedback.
- **A company is rows:** an offer, leads, samples, a grant, a status and decisions. Spawning creates nothing in Naïve.
- **Samples are served by the foundry app** from the `samples` table at `/s/<lead_id>`. There's no per-company app.
- **One shared identity and inbox,** owned by the Closer. Outreach sends from it.
- **Hand-offs are board cards** that the foundry app creates, assigned to the next agent.
- **The foundry caps each company's spending** at what VC granted it.

## Non-goals

- A custom sending domain, sender name or postal address.
- Live Stripe. That's a separate step, and the payments code stays as it is.
- Social channels: X, Reddit, GitHub or Hacker News replies.
- Any dashboard change beyond the two buttons and a running or stopped indicator.

## Anti-goals

These count as failures even if the system technically works:

- Naïve resources that grow with the number of companies.
- Any agent working while the company is stopped.
- A company spending more than VC granted it.
- End deleting data or losing a company's state.
- The buttons working for someone who only has the public URL.
- An agent claiming to be a person.

## Current state

- **No companies exist.** On Nov 8 every company was deleted (co-01 to co-03 and the TEST company), along with their agents, apps, identities, inboxes and records. So there's nothing to migrate.
- **No agent schedules exist.** The parent agents (Scout, Compliance, Creator, VC and Feedback) are still in the org.
- **The foundry has 62 leads and 13 approved clusters waiting.**

## Constraints, verified on this org

- **Waking an agent.** A board card assigned to an agent wakes it within seconds. This worked on Nov 8 for the Builder, Outreach and the Closer. Creating a card needs only `agents:write`, which the app's key (`NAIVE_WRITE_KEY`) has. The key can't start sessions: that needs `sessions:write`, which only an admin can grant, and #45 dropped it for that reason.
- **Agents may not have board tools.** The child agents spawned on Nov 8 couldn't read or move cards. So a card's title must carry everything the agent needs, such as the lead and company ids, because the title arrives in the wake message.
- **Stopping an agent.** A budget cap of 0 stops it before its next model call; `kill` reads the zero back today. `agents:write` covers budgets and schedules.
- **Inbound email** wakes the agent that owns the inbox.
- **Email.** It's plain text only. A message has `to`, `subject` and `text`, with no display name, HTML or reply-to.
- **The Naïve dashboard gate.** A `DASHBOARD_TOKEN` secret on the app makes the Studio open it through `/apps/{id}/open`. Naïve hands the browser a two-minute signed ticket, which the app swaps for its own session cookie. There's also a `DASHBOARD_PASSWORD` for entry without the Studio.
- **Naïve's limits.** The shortest schedule is every 5 minutes. Scheduled runs use the `loose` window, because `immediate` pre-flight quotes are about $0.22 a call, above small run budgets. `loose` runs hit `job_not_ready` when Naïve is at capacity, and the API answers 429 under load.

## The loop

| # | Trigger | Agent | What it does | Hands off by |
|---|---|---|---|---|
| 1 | Launch, then every 2 hours | Scout | Runs the four business playbooks (`maps`, `reviews`, `appstore`, `jobs`), 5 minutes apart. Saves clusters and leads. | Each run's `on_idle` ping to `/api/scout-idle` |
| 2 | All four runs of a cycle have pinged | Compliance | Screens the batch (`screen_batch`, `submit_screen`, unchanged) | The approved clusters join Creator's queue |
| 3 | A Creator card for a queued cluster | Creator | Reads the cluster's leads, writes the offer (`propose_offer`), opens the company (`spawn`, rows only), and builds a sample page for each of up to N leads (`publish_sample`) | The company becomes `proposed` once its samples are published |
| 4 | Every 5 minutes | VC | First calls `foundry.reconcile` (the sweep below). Then kills, grants more and makes first grants, as `agents/prompts/vc.md` says. A proposed company it decides not to fund, it now kills. | A first grant creates one Outreach card per sampled lead |
| 5 | An Outreach card | Outreach | Sends the offer's first message from the shared inbox, then logs the touch | Replies arrive in the shared inbox |
| 6 | An email to the shared inbox | Closer | Finds the lead from the sender or the quoted sample link, answers, sends `checkout_link`, and logs the reply with the inbound message's id | A buyer pays through Stripe |
| 7 | A paid Stripe event (webhook, unchanged) | none | Marks the lead paid | One Closer card: deliver this lead's product |
| 8 | A Closer Deliver card | Closer | Delivers the product, then logs `delivered` | none |
| 9 | VC records a fund or kill decision | Feedback | Writes its note for Scout's memory | none |

A company "dies" when VC kills it. The app then closes the company's open cards, creates no new work for it, and refuses its foundry tool calls (`killed`). There's one exception: a payment that lands after the kill is still recorded and delivered (see Money).

**Creator's queue.** An approved cluster gets a Creator card only while fewer than `max_proposed` companies are waiting (`spawning` or `proposed`). The rest wait as approved clusters. A slot frees when VC funds a waiting company or kills one it declines.

**When Creator is woken again for a cluster:**
- when VC kills one of its companies, to consider a revised offer if the cluster still has unassigned leads
- on a company's first payment, to consider a sibling company from the same offer
- on a second or third grant, to sample the company's next 5 leads (see Money)

## The five-minute sweep

`foundry.reconcile` is a new tool. VC calls it at the start of every pass, and Launch calls it right away. It works out from the foundry's records what should be happening and creates any missing card. Card keys stop it from creating anything twice. It hands out:

- **Creator cards** for queued clusters, while there's a free slot.
- **A Compliance card** for a Scout batch 90 minutes into its cycle, if not every run reported finishing.
- **Outreach cards** for funded companies' sampled leads that haven't been contacted.
- **Follow-up cards** for leads due their one follow-up: 20 or more hours since the first email, no reply. They go out 20 hours to 20 hours 5 minutes after the first email.
- **Deliver cards** for paid leads that haven't been delivered.
- **Closer cards** for inbound emails with no logged reply after 10 minutes. The sweep lists the shared inbox's recent inbound messages and compares them with the message ids the Closer logged. This also catches replies that arrived while the Closer was stopped or out of budget.

The sweep does nothing while the company is stopped. Launch runs it once, which hands out everything End held back.

## Launch and End

- **State.** One `foundry_state` row records whether the company is running and when that last changed.
- **Launch:**
  1. Set each of the seven agents' budget caps to its configured cap.
  2. Turn on Scout's four schedules and VC's schedule.
  3. Move cards that were parked by a zero budget back to `todo`, as `fund` does today.
  4. Mark the state running.
  5. Run the sweep.
- **End:**
  1. Mark the state stopped. From then on, the foundry creates no cards and refuses every tool that writes.
  2. Turn off both schedules.
  3. Set all seven agents' caps to 0. A session that's mid-task stops at its next model call.

  Cards and data stay as they are.
- **Buttons.** Launch and End post to `/api/control/launch` and `/api/control/stop`, which accept only a request with the Naïve dashboard session cookie. Visitors on the public URL see the dashboard without the buttons, and the endpoints refuse them. The page shows whether the company is running and since when.

## Money

- **Parent agents** (Scout, Compliance, Creator and Feedback) keep their own daily caps, as today.
- **VC's cap goes from $2 to $15 a day.** That covers 288 five-minute passes at up to about $0.05 each. The owner accepted that cost when choosing the 5-minute check, and `scripts/parent-config.ts` must allow it.
- **Creator pays for samples before funding,** out of its own budget, for at most N leads per company.
- **Companies are funded by VC grants.** `funding_policy` is unchanged: $5 grants and a $10 placeholder pool until the cost experiment (#22). Once $10 has been granted, nothing more is funded until the owner raises the pool.
- **What a grant pays for.** A first grant pays for Outreach and Closer work on the company's first 5 sampled leads. A second or third grant also assigns the next 5 unassigned leads in the cluster and wakes Creator to sample them. That Creator work is charged to the company's grant.
- **The shared Outreach and Closer** each have an agent cap as an overall safety limit, plus a per-task cap.
- **Spend per company.** Each Outreach and Closer session is charged to the company on the card that woke it. For an inbound email, it's the company of the lead the Closer finds. The foundry records that spend from Naïve's per-session usage (`consumed_micro_usd`). Once a company's spend reaches its grant, the app stops creating cards for it until VC grants more or kills it.
- **Payments after a kill or during End.** The payment is always recorded, and the lead is always delivered. Money was taken, so the product goes out. After a kill, the Deliver card is still created, and the Closer's own budget pays for it rather than the dead company's grant. During End, delivery waits for Launch. `kill` doesn't close open checkouts, but `checkout_link` already refuses a killed company.

## What changes in the code

- **`spawn`** writes rows only: the company, its leads (up to N) and the `spawn` decision. No identity, app, agents, inbox or cards.
- **`fund`** records the grant and creates the Outreach cards. It no longer changes agent budgets.
- **`kill`** marks the company killed and closes its open cards. It no longer changes agent budgets.
- **`publish_sample`** stores the page and sets `sample_url` to `<foundry url>/s/<lead_id>`. A new route serves samples from the `samples` table. No redeploy.
- **`find_lead`** can search without a `company_id`, for the Closer's inbound replies.
- **`checkout_link` and payments** are unchanged, except that the Deliver card goes to the shared Closer.
- **`log_touch`** records the inbound message id the Closer answered, so the sweep can find unanswered emails.
- **`agents/prompts/vc.md`** calls `foundry.reconcile` first, and kills a proposed company it decides not to fund.
- **New pieces:**
  - the state row and the control endpoints, with the Naïve dashboard gate
  - a helper that creates keyed cards
  - `/api/scout-idle` waking Compliance
  - `foundry.reconcile`, the five-minute sweep
  - `submit_screen` waking Creator
  - VC's fund and kill decisions waking Feedback
- **Agents.** Shared `outreach` and `closer` configs replace `templates/child/`. Creator gets `web_fetch` and `publish_sample`, and the Builder template goes. There's one identity and inbox on the system domain.
- **Scout** runs every 2 hours instead of 3 (`CYCLE_HOURS`).
- **Removed:** Compliance's polling schedule, Creator's hourly schedule, the per-company Outreach follow-up schedule, and Feedback's schedule.
- **Docs.** The contract (sections 1, 4, 5 and 7), `docs/scout.md`, `docs/compliance.md` and `docs/creator-vc.md` match the new design.

## Left to the builder

- The exact card-title format, and which board each card goes on.
- How a Naïve session is tied to the card or company it worked for, for spend. Check whether a card-woken session carries the card in its metadata. If not, read the session's first message, which contains the card title.
- Retries and idempotency when creating cards. Card keys exist for this.
- How the dashboard gate's ticket exchange and cookie are implemented, following Naïve's `apps.entry` contract.

## Calls I made, for the owner to check

- **N = 5:** Creator samples at most 5 leads per company before funding, and each extra grant adds the next 5.
- **VC's 5-minute pass is also the sweep.** That keeps two timers while catching follow-ups, missed Scout signals, unanswered emails and work held back by End.
- **VC kills a proposed company it won't fund,** so its slot frees for the next queued cluster.
- **VC's cap rises to $15 a day** to fit the 5-minute check you chose.
- **Creator is woken again** on a kill (to revise the offer), on a first payment (to consider a sibling) and on extra grants (to sample more leads).
- **Feedback is woken by VC's fund and kill decisions,** not by a schedule.
- **A paid lead is always delivered,** even after a kill. The Closer's own budget pays for that.
- **The shared inbox is `hello@auto-foundry-03s9ve.usenaive.ai`.**
- **The shared Outreach and Closer** are capped at $5 a day each, with $0.30 per task.
