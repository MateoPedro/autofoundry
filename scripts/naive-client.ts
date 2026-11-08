import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolve credentials without printing or copying them into agent configs or artifacts.
export async function naiveClient(timeoutMs = 30_000) {
  const { createClient } = await import("@usenaive-sdk/managed-agents");
  let apiKey = process.env.NAIVE_API_KEY?.trim() || process.env.VETTA_API_KEY?.trim();
  let baseUrl = process.env.NAIVE_API_BASE_URL || process.env.VETTA_API_BASE_URL;
  if (!apiKey) {
    const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vetta", "config.json");
    let saved;
    try { saved = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error("Naïve login unavailable. Run pnpm naive:login in your terminal."); }
    const profile = saved.profiles?.[process.env.VETTA_PROFILE || saved.default_profile || "prod"];
    apiKey = profile?.api_key;
    baseUrl ||= profile?.base_url;
  }
  if (!apiKey) throw new Error("Naïve login unavailable. Run pnpm naive:login in your terminal.");
  const origin = new URL(baseUrl || "https://api.vetta.sh");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Naïve API base must be an HTTPS origin without credentials or a path.");
  }
  const client = createClient({ apiKey, baseUrl: origin.origin,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  const identity = await client.auth.me();
  if (identity.organization?.name.replace(/[\s_-]/g, "").toLowerCase() !== "autofoundry") {
    throw new Error("Select the shared Auto Foundry organization before running Scout.");
  }
  return client;
}
