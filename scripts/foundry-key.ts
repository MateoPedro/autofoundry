import { naiveClient } from "./naive-client";

// Gives the foundry app an org API key with write access, stored as the app secret NAIVE_WRITE_KEY.
// spawn, fund and kill need agents:write, which apps.request_access never grants; the app's
// approved read-only key stays in NAIVE_API_KEY for the spend sync.
// Run it yourself: the key goes straight from Naïve into the app and is never printed.
const APP_NAME = "foundry";
const SECRET = "NAIVE_WRITE_KEY";
const SCOPES = ["agents:read", "agents:write"] as const;

async function main() {
  const client = await naiveClient();
  const apps = await client.apps.list({ name: APP_NAME });
  const app = apps.data[0];
  if (!app) throw new Error(`No app named ${APP_NAME} in this organization.`);

  const secrets = await client.apps.secrets(app.id);
  if (secrets.data.some((s) => s.name === SECRET)) {
    console.log(`${APP_NAME} already has ${SECRET}. To replace it, revoke the old key under API keys first, then delete the secret.`);
    return;
  }

  const key = await client.keys.create({ name: `${APP_NAME}-app-write`, scopes: [...SCOPES] });
  await client.apps.setSecret(app.id, { name: SECRET, value: key.secret });
  console.log(`Created key ${key.id} (${SCOPES.join(", ")}) and stored it as ${SECRET} on ${APP_NAME} (${app.id}).`);
  console.log("Redeploy the app so the new environment variable takes effect.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Failed to set the foundry key.");
  process.exitCode = 1;
});
