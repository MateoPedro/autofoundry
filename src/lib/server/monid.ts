// Monid read sources, shared by the local scripts and the foundry app's monid_read tool.
// Only these fixed read endpoints can run: Monid's catalog also has write and provisioning
// endpoints, so nothing here takes a provider or endpoint from the caller.

// Inspected November 7. Prices are integer micro-USD per call for the pinned route.
export const READ_SOURCES = {
  github_issues: { provider: "anyapi", endpoint: "/github.search_issues", route: "chameleon", maxMicroUsd: 2400 },
  hackernews: { provider: "anyapi", endpoint: "/hackernews.search", route: "hedgehog", maxMicroUsd: 1500 },
  reddit: { provider: "anyapi", endpoint: "/reddit.search", route: "bison", maxMicroUsd: 350 },
  x_search: { provider: "anyapi", endpoint: "/twitter.search", route: "lynx", maxMicroUsd: 540 },
} as const;
export type ReadSource = keyof typeof READ_SOURCES;

export type MonidRun = { runId?: string; status?: string; providerResponse?: { httpStatus?: number }; cost?: { value?: number };
  billing?: { reportedCost?: { value?: number } }; output?: { data?: unknown } };
export type MonidReader = { readSource(name: ReadSource, body: Record<string, unknown>): Promise<unknown>; getRun(runId: string): Promise<unknown> };

export function createMonidReader(apiKey: string, fetcher: typeof fetch = fetch): MonidReader {
  async function request(url: string, body: unknown) {
    const response = await fetcher(url, { method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Monid request failed (HTTP ${response.status}).`);
    return response;
  }
  return {
    readSource: async (name, body) => {
      const source = READ_SOURCES[name];
      if (!source) throw new Error("Unknown Monid read source.");
      const { provider, endpoint, route, maxMicroUsd } = source;
      // Inspection is free. Refuse before any billed run if the endpoint or its price changed.
      const details = await (await request("https://api.monid.ai/v1/inspect", { provider, endpoint })).json();
      const variant = details.price?.type === "PER_CALL" ? details.price : details.price?.variants?.find((v: { when?: { route?: string } }) => v.when?.route === route)?.price;
      if (details.provider !== provider || details.endpoint !== endpoint || details.method !== "POST" || variant?.type !== "PER_CALL" || variant.amount?.currency !== "USD" || typeof variant.amount.value !== "number" || variant.amount.value < 0 || Math.round(variant.amount.value * 1_000_000) > maxMicroUsd) {
        throw new Error(`${name}: endpoint identity, method or price changed; no provider run was started.`);
      }
      // Monid takes USD for maxCost.
      return (await request("https://api.monid.ai/v1/run", { provider, endpoint, maxCost: maxMicroUsd / 1_000_000,
        input: { body: { ...body, route } } })).json();
    },
    getRun: async (runId) => {
      if (!/^[a-z0-9_-]{16,80}$/i.test(runId)) throw new Error("Invalid Monid run ID.");
      const response = await fetcher(`https://api.monid.ai/v1/runs/${runId}`, { signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new Error(`Monid result request failed (HTTP ${response.status}).`);
      return response.json();
    },
  };
}

// What a run cost: the reported bill, else the quoted cost, else the worst case for a completed run.
export function runCost(run: MonidRun, worstMicroUsd: number) {
  return run.billing?.reportedCost?.value ?? Math.round((run.cost?.value ?? (run.status === "COMPLETED" ? worstMicroUsd / 1_000_000 : 0)) * 1_000_000);
}
