import { randomBytes } from "node:crypto";
import { CREW_ROLES } from "../src/lib/server/foundry/roles";
import { crewRowsSql, planCrewSetup, type CrewRow } from "./crew-plan";
import { naiveClient } from "./naive-client";

const USAGE = "pnpm crew setup --foundry-app app_ID | access --foundry-app app_ID";
const IDENTITY = "autofoundry";
const LOCALPART = "hello";

async function main() {
  const [command = "", flag, appId] = process.argv.slice(2);
  if (!["setup", "access"].includes(command) || flag !== "--foundry-app" || !/^app_[a-z0-9]+$/.test(appId ?? "")) throw new Error(USAGE);
  const client = await naiveClient();
  const app = await client.apps.get(appId);
  if (app.name !== "foundry") throw new Error("The app must be the foundry.");

  if (command === "access") {
    // A fresh operator password, set on the app and shown once here. Not apps.rotateAccess: that also
    // turns a DASHBOARD_TOKEN on, which makes the Studio open the app through an entry ticket the
    // foundry doesn't accept (src/lib/server/gate.ts).
    const password = randomBytes(18).toString("base64url");
    await client.apps.setSecret(app.id, { name: "DASHBOARD_PASSWORD", value: password });
    console.log(`Operator password: ${password}`);
    console.log("Redeploy the foundry app, then sign in on the dashboard with it. Rerun this command to change it.");
    return;
  }

  const found: Partial<Record<string, string>> = {};
  let after: string | undefined;
  do {
    const page = await client.agents.list({ limit: 100, after });
    for (const a of page.data) if ((CREW_ROLES as readonly string[]).includes(a.name) && a.metadata.project === "autofoundry") found[a.name] = a.id;
    after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (after);

  const domain = (await client.domains.list({ limit: 100 })).data.find((d) => d.kind === "system" && d.status === "active");
  if (!domain) throw new Error("The organization has no active system email domain.");
  const address = `${LOCALPART}@${domain.name}`;
  const identity = (await client.identities.list({ limit: 100 })).data.find((i) => i.name === IDENTITY);
  const inboxes = identity ? (await client.emails.list(identity.id, { limit: 100 })).data : [];
  const inbox = inboxes.find((i) => i.address === address) ?? null;
  const plan = planCrewSetup({ agents: found, identityId: identity?.id ?? null, inbox });
  const { agents } = plan;

  const identityId =
    identity?.id ?? (await client.identities.create({ name: IDENTITY, description: "AutoFoundry's shared inbox", metadata: { project: "autofoundry" } })).id;
  // An inbox's owner must hold the identity, and Outreach sends from the same inbox.
  for (const role of ["outreach", "closer"] as const) await client.identities.attach(agents[role], identityId);
  const inboxId = inbox?.id ?? (await client.emails.create(identityId, { address, owning_agent_id: agents.closer })).id;

  const rows: CrewRow[] = [];
  for (const role of CREW_ROLES) {
    const board = await client.board.create(agents[role]);
    rows.push({ role, agent_id: agents[role], board_id: board.id, ...(role === "closer" ? { identity_id: identityId, inbox_id: inboxId, inbox_address: address } : {}) });
  }
  await client.database.query(crewRowsSql(rows), { app: app.id });
  console.log(JSON.stringify({ created_identity: plan.createIdentity, created_inbox: plan.createInbox, inbox: address, crew: rows.map((r) => r.role) }));
}

main().catch(async (error) => {
  const { ApiError } = await import("@usenaive-sdk/managed-agents");
  console.error(error instanceof ApiError ? `Request failed (HTTP ${error.status}, ${error.code}).` : error instanceof Error ? error.message : "Failed.");
  process.exitCode = 1;
});
