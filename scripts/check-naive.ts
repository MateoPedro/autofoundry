import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type SavedProfile = { api_key?: string; base_url?: string };
type LoginConfig = { default_profile?: string; profiles?: Record<string, SavedProfile> };

async function main() {
  let apiKey = process.env.NAIVE_API_KEY?.trim() || process.env.VETTA_API_KEY?.trim();
  let baseUrl = process.env.NAIVE_API_BASE_URL || process.env.VETTA_API_BASE_URL;
  let credentialSource = "local environment";

  // The official CLI stores both API-key and account-session logins here.
  if (!apiKey) {
    const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vetta", "config.json");
    let config: LoginConfig = {};
    try {
      config = JSON.parse(await readFile(configPath, "utf8")) as LoginConfig;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Unable to read the saved Naïve CLI login. Run pnpm naive login again.");
      }
    }
    const profileName = process.env.VETTA_PROFILE || config.default_profile || "prod";
    const profile = config.profiles?.[profileName];
    apiKey = profile?.api_key?.trim();
    baseUrl ||= profile?.base_url;
    credentialSource = "saved CLI login";
  }

  if (!apiKey) {
    console.error("Naïve is not connected. Add NAIVE_API_KEY to .env.local, or sign in with the official CLI (pnpm naive login --help).");
    process.exitCode = 1;
    return;
  }

  const origin = new URL(baseUrl || "https://api.vetta.sh");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Naïve API base URL must be an HTTPS origin without a path or embedded credentials.");
  }

  const { createClient, ApiError } = await import("@usenaive-sdk/managed-agents");
  const client = createClient({
    baseUrl: origin.origin,
    apiKey,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  });

  try {
    const identity = await client.auth.me();
    if (!identity.organization) {
      console.error("Signed in, but this credential has no selected organization. Select the shared AutoFoundry organization and sign in again.");
      process.exitCode = 1;
      return;
    }

    console.log(`Organization: ${identity.organization.name} (${identity.organization.id})`);
    console.log(`Mode: ${identity.organization.mode}`);
    console.log(`Credential source: ${credentialSource}`);

    const checks = await Promise.allSettled([
      client.credits.show(),
      client.credits.subscription(),
      client.agents.list({ limit: 1 }),
      client.apps.list({ limit: 1 }),
    ]);
    const names = ["Credits", "Plan", "Agents read access", "Apps read access"];
    for (let index = 0; index < checks.length; index++) {
      const result = checks[index];
      if (result.status === "rejected") {
        const detail = result.reason instanceof ApiError ? `HTTP ${result.reason.status}` : "request failed";
        console.error(`${names[index]}: ${detail}`);
        process.exitCode = 1;
        continue;
      }
      const value = result.value;
      if ("balance_micro_usd" in value) {
        console.log(`Credits: $${(value.balance_micro_usd / 1_000_000).toFixed(2)}`);
      } else if ("status" in value) {
        console.log(`Plan: ${value.plan || "unspecified"} (${value.status})`);
        if (value.status !== "active") process.exitCode = 1;
      } else {
        console.log(`${names[index]}: OK`);
      }
    }
    console.log("Read-only checks complete. No agents, apps, subscriptions, or paid tasks were created.");
  } catch (error) {
    // Provider errors can contain raw request details. Report only the status.
    console.error(error instanceof ApiError ? `Naïve connection failed (HTTP ${error.status}).` : "Naïve connection failed. Check the login, API origin, and network connection.");
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("Naïve setup check could not load local configuration. Check the CLI login and API base URL.");
  process.exitCode = 1;
});
