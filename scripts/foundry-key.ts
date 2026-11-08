import { naiveClient } from "./naive-client";

// Gives the foundry app an org API key, stored as the app secret NAIVE_WRITE_KEY. spawn, fund and
// kill need agents:write and the spend sync needs billing:read; apps.request_access grants neither.
// Run it yourself: the key goes straight from Naïve into the app and is never printed.
// --replace revokes the app's earlier write key and makes a new one.
const APP_NAME = "foundry";
const SECRET = "NAIVE_WRITE_KEY";
// sessions:read charges each crew session to its company (src/lib/server/foundry/spend.ts).
const SCOPES = ["agents:read", "agents:write", "billing:read", "sessions:read"] as const;
const KEY_NAME = `${APP_NAME}-app-write`;

async function main() {
  const client = await naiveClient();
  const apps = await client.apps.list({ name: APP_NAME });
  const app = apps.data[0];
  if (!app) throw new Error(`No app named ${APP_NAME} in this organization.`);

  const secrets = await client.apps.secrets(app.id);
  if (secrets.data.some((s) => s.name === SECRET)) {
    if (!process.argv.includes("--replace")) {
      console.log(`${APP_NAME} already has ${SECRET}. Run pnpm foundry:key --replace to revoke it and make a new one.`);
      return;
    }
    const keys = await client.keys.list({ limit: 100 });
    for (const old of keys.data.filter((k) => k.name === KEY_NAME)) {
      await client.keys.revoke(old.id);
      console.log(`Revoked key ${old.id}.`);
    }
    await client.apps.deleteSecret(app.id, SECRET);
  }

  const key = await client.keys.create({ name: KEY_NAME, scopes: [...SCOPES] });
  await client.apps.setSecret(app.id, { name: SECRET, value: key.secret });
  console.log(`Created key ${key.id} (${SCOPES.join(", ")}) and stored it as ${SECRET} on ${APP_NAME} (${app.id}).`);
  console.log("Redeploy the app so the new environment variable takes effect.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Failed to set the foundry key.");
  process.exitCode = 1;
});
