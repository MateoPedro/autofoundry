# Operations

How to run AutoFoundry: what Launch and End do, how the operator signs in, and the one-time rollout of the shared crew. The design is in [the foundry contract](foundry-contract.md), section 4.

## Launch and End

One row, `foundry_state`, records whether the company is running and when that last changed. The dashboard shows it to everyone. Only a signed-in operator sees the **Launch** and **End** buttons. They post to `/api/control/launch` and `/api/control/stop`, which answer 401 to anyone without the operator cookie. A form post comes back to the dashboard with the result in the address. Any other request gets the JSON report.

Both need `NAIVE_WRITE_KEY` on the app. Naïve answers 429 under load, so each Naïve call gets three tries.

### Launch

Launch refuses to start if any of the seven agents has no row in `crew` (run `pnpm crew setup`). Then it:

1. Sets each of the seven agents' daily caps back to its configured cap (`ROLE_BUDGETS` in `src/lib/server/foundry/roles.ts`).
2. Turns on every schedule of Scout (four) and VC (one).
3. Moves cards that Naïve parked because of a zero budget back to `todo`.
4. Marks the state running.
5. Runs the sweep (`reconcile`) once, which creates any card End held back.

Launch is all-or-nothing. If any budget, schedule or card call still fails after its retries, Launch runs End and reports `running: false` with the errors. If only the first sweep fails, the company still runs, the error is reported, and VC's next pass runs the sweep again.

### End

End:

1. Marks the state stopped first. From then on the foundry creates no card, and every tool that writes answers `stopped`.
2. Turns off Scout's and VC's schedules.
3. Sets all seven agents' caps to 0. A session that is mid-task stops at its next model call.

End deletes nothing. Cards, companies, leads, samples and decisions stay as they are. A Naïve refusal is reported, and End carries on with the remaining calls. Payments are still recorded while stopped, and the sweep creates the Deliver card after the next Launch.

## Signing in as the operator

The dashboard is public, but the buttons need the operator cookie. The only sign-in path is the operator password:

1. Run `pnpm crew access --foundry-app app_ID`. It sets a fresh `DASHBOARD_PASSWORD` secret on the foundry app and prints it once. Run it again to change the password.
2. Redeploy the foundry app so the secret takes effect.
3. Open the dashboard, enter the password in the sign-in form, and the app sets the `foundry_operator` cookie for 30 days.

The cookie is keyed by the password, so changing the password signs every browser out. Members of the Naïve organization can also read the password in the Naïve Studio.

**One-click sign-in from the Studio is not supported yet.** The Studio opens an app that has a `DASHBOARD_TOKEN` secret through a two-minute signed ticket that the app has to verify. Naïve doesn't document which fields the ticket signs or how they are encoded. Finding out means minting a ticket, which needs `DASHBOARD_TOKEN` set on the live app, and that secret wasn't set (Nov 8). So the foundry ignores a posted ticket. `pnpm crew setup` and `pnpm crew access` also leave `DASHBOARD_TOKEN` unset on purpose: with it set, the Studio would open the app through a ticket the foundry can't verify.

## One-time rollout

Run these in order. Replace `app_ID` with the foundry app's id, `app_f27yeve1gzgmztexhf9d0wbx62`. Each command needs the Naïve login from [local setup](naive-setup.md).

1. Apply the schema change. It adds `foundry_state`, `crew`, `work_cards`, `session_spend`, `inbound_seen` and `touches.message_id`.

   ```sh
   pnpm naive db migrate migrations/0009_shared_crew.sql --app foundry
   ```

2. Set `FOUNDRY_URL` on the foundry app to its public https URL, then redeploy. Samples and checkout return links are built from it. Until it is set, `/mcp` and the webhooks answer 500.

3. Replace the app's write key and redeploy. The new key adds `sessions:read`, which charges each crew session to its company.

   ```sh
   pnpm foundry:key --replace
   ```

4. Apply the seven agents. Each command checks its config, then creates or updates the agent.

   ```sh
   pnpm parent creator apply --foundry-app app_ID
   pnpm parent vc apply --foundry-app app_ID
   pnpm parent feedback apply --foundry-app app_ID
   pnpm parent outreach apply --foundry-app app_ID
   pnpm parent closer apply --foundry-app app_ID
   pnpm scout apply --foundry-app app_ID
   pnpm compliance apply --mode screen --foundry-app app_ID
   ```

5. Set up the crew. It finds the seven agents, creates the shared identity (`autofoundry`) and the inbox `hello@<system domain>` owned by the Closer, gives each agent its own board, and writes the `crew` table. It stops and names any missing agent.

   ```sh
   pnpm crew setup --foundry-app app_ID
   ```

6. Set the operator password, then redeploy.

   ```sh
   pnpm crew access --foundry-app app_ID
   ```

7. Create Scout's webhook token, then redeploy the app. The token goes to the app secret `SCOUT_IDLE_TOKEN` and to `.env.local`, and is never printed.

   ```sh
   pnpm scout idle-token
   ```

8. Create the schedules. They are created off.

   ```sh
   pnpm scout deploy
   pnpm parent vc deploy
   ```

9. Open the dashboard, sign in with the operator password, and press **Launch**.

Each command exists as written, with these checks against the scripts:

- `pnpm foundry:key --replace` is the flag `scripts/foundry-key.ts` reads. Without it, the script stops if `NAIVE_WRITE_KEY` already exists.
- `pnpm parent <role> apply` takes `--foundry-app`, and the role is one of `creator`, `vc`, `feedback`, `outreach` or `closer`. Only `vc` has a `deploy`; the others have no schedule.
- `pnpm scout deploy` needs `pnpm scout apply --foundry-app` first and `SCOUT_IDLE_TOKEN` in `.env.local`, which is why `idle-token` comes before it.
- `pnpm compliance deploy` is not part of the rollout. Screen mode has no schedule and the command refuses.

If you change an agent's config later, apply it again and run `pnpm scout deploy` (or `pnpm parent vc deploy`) to repin the schedules to the new version. Redeploying leaves a schedule's on or off state alone.
