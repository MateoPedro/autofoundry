import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { monidClient } from "./monid-client";

// One deliberately small workflow: Maps -> two fixed Monid page audits -> Scout -> Compliance queue.
// No separate service, queue, scheduler, or provider-controlled execution options.
export async function collectMapsPipeline(client: VettaClient, requestId: string, query: string,
  options: { directory?: string; monid?: Pick<ReturnType<typeof monidClient>, "auditPage" | "getRun"> } = {}) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) || !query.trim() || query.length > 300) throw new Error("Use a valid request ID and a Maps query of 1..300 characters.");
  const monid = options.monid || monidClient();
  const directory = options.directory || resolve("var/scout/pipeline");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${requestId}.json`);
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (previous.query !== query) throw new Error("Pipeline request ID belongs to a different query.");
    return { path, context: previous.context as string };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try { await writeFile(join(directory, `${requestId}.started`), JSON.stringify({ query, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("This source collection already started but has no completed receipt. Inspect provider runs before starting another paid request."); }
  const found = await client.data.searchTools({ query: "Google Maps Results", domain: "search", limit: 8 });
  const tool = found.data.find(t => t.name === "Google Maps Results");
  if (!tool || tool.price.basis !== "per_call" || tool.price.micro_usd > 2000) throw new Error("Verified Maps endpoint or price unavailable; pipeline stopped.");
  await client.data.getTool(tool.id);
  const maps = await client.data.run({ tool_id: tool.id, body: { keyword: query, location_name: "San Francisco,California,United States", language_code: "en", depth: 5 } });
  if (maps.status !== "succeeded" || !Array.isArray(maps.data)) throw new Error("Maps source failed; pipeline stopped before auditing.");
  const listings = maps.data.flatMap((page: { items?: unknown[] }) => page.items || []).slice(0, 5).map((value: unknown) => {
    const item = value as { place_id?: string; title?: string; url?: string; contact_url?: string; category?: string; address?: string };
    return { external_id: item.place_id, name: item.title, url: item.url, contact_url: item.contact_url, category: item.category, address: item.address };
  });
  const audits: unknown[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const listing of listings) {
    if (!listing.url || audits.length >= 2) continue;
    let url;
    try { url = new URL(listing.url); } catch { continue; }
    url.protocol = "https:";
    if (seen.has(url.hostname)) continue;
    seen.add(url.hostname);
    try {
      let result = await monid.auditPage(url.href);
      // Read/poll an existing execution; never start a second run as a retry.
      for (let poll = 0; result.status === "RUNNING" && poll < 10; poll++) {
        await new Promise(r => setTimeout(r, 2000));
        result = await monid.getRun(result.runId);
      }
      audits.push(result);
      if (result.status !== "COMPLETED" || !(result.providerResponse?.httpStatus >= 200 && result.providerResponse?.httpStatus < 300)) notes.push(`Audit for ${url.hostname} has no usable result (${result.status}); do not infer page issues from it.`);
    } catch {
      // A lost execution response could have been billed. Stop initiating audits, keep partial evidence.
      notes.push(`Audit for ${url.hostname} failed or its response was lost; no automatic execution retry.`);
      break;
    }
  }
  const observations = { query, observed_at: maps.created_at, maps_cost_micro_usd: maps.cost_micro_usd,
    listings, audits, notes, max_monid_calls: 2, max_monid_micro_usd: 300 };
  const context = JSON.stringify(observations);
  if (context.length > 40000) throw new Error("Pipeline evidence exceeds the bounded context size; inspect provider receipts before continuing.");
  await writeFile(path, JSON.stringify({ request_id: requestId, query, context, observations }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { path, context };
}
