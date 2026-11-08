// Server/local use only. Credentials never enter agent prompts or saved source artifacts.
export function monidClient(apiKey = process.env.MONID_API_KEY?.trim(), fetcher: typeof fetch = fetch) {
  if (!apiKey) throw new Error("Save MONID_API_KEY in .env.local before connecting Monid.");
  async function request(url: string, body: unknown, extra: Record<string, string> = {}) {
    const response = await fetcher(url, { method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Monid request failed (HTTP ${response.status}).`);
    return response;
  }
  return {
    // These catalog operations do not execute a provider endpoint or spend wallet credit.
    discover: async (query: string) => {
      if (!query.trim() || query.length > 500) throw new Error("Use a discovery query of 1..500 characters.");
      return (await request("https://api.monid.ai/v1/discover", { query, limit: 5 })).json();
    },
    inspect: async (provider: string, endpoint: string) => {
      if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(provider) || !endpoint.startsWith("/") || endpoint.length > 1000) throw new Error("Specify a provider slug and endpoint path from discovery.");
      return (await request("https://api.monid.ai/v1/inspect", { provider, endpoint })).json();
    },
    searchPosts: async (query: string) => {
      if (!query.trim() || query.length > 500) throw new Error("Use a post query of 1..500 characters.");
      const provider = "twitterdata.io", endpoint = "/tweets/search";
      const details = await (await request("https://api.monid.ai/v1/inspect", { provider, endpoint })).json();
      // Fixed read endpoint and fixed per-call pricing only. Never execute arbitrary catalog tools.
      if (details.provider !== provider || details.endpoint !== endpoint || details.method !== "GET" || details.price?.type !== "PER_CALL" || details.price.amount?.currency !== "USD" || typeof details.price.amount.value !== "number" || details.price.amount.value < 0 || details.price.amount.value > 0.00025) {
        throw new Error("X endpoint identity, read method or price changed; no provider run was started.");
      }
      // Monid takes USD here; 250 integer micro-USD / 1,000,000 = $0.00025.
      return (await request("https://api.monid.ai/v1/run", { provider, endpoint, maxCost: 250 / 1_000_000,
        input: { queryParams: { query, limit: 10 } } })).json();
    },
    auditPage: async (url: string) => {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || !/\.[a-z]{2,}$/i.test(target.hostname) || /\.(local|internal)$/i.test(target.hostname)) throw new Error("Audit requires a public HTTPS business URL.");
      const provider = "dataforseo", endpoint = "/onpage/instant-pages";
      const details = await (await request("https://api.monid.ai/v1/inspect", { provider, endpoint })).json();
      if (details.provider !== provider || details.endpoint !== endpoint || details.method !== "POST" || details.price?.type !== "PER_CALL" || details.price.amount?.currency !== "USD" || typeof details.price.amount.value !== "number" || details.price.amount.value < 0 || details.price.amount.value > 0.00015) throw new Error("Audit endpoint or price changed; no provider run was started.");
      return (await request("https://api.monid.ai/v1/run", { provider, endpoint, maxCost: 150 / 1_000_000,
        input: { body: { url: target.href, enable_javascript: false, load_resources: false, enable_browser_rendering: false, enable_xhr: false, store_raw_html: false } } })).json();
    },
    // Fixed read-only endpoints for scouting. Never a caller-chosen provider/endpoint: Monid's catalog
    // also executes write and provisioning endpoints, which Scout must not reach.
    readSource: async (name: keyof typeof READ_SOURCES, body: Record<string, unknown>) => {
      const source = READ_SOURCES[name];
      if (!source) throw new Error("Unknown Monid read source.");
      const { provider, endpoint, route, maxMicroUsd } = source;
      const details = await (await request("https://api.monid.ai/v1/inspect", { provider, endpoint })).json();
      const variant = details.price?.type === "PER_CALL" ? details.price : details.price?.variants?.find((v: { when?: { route?: string } }) => v.when?.route === route)?.price;
      if (details.provider !== provider || details.endpoint !== endpoint || details.method !== "POST" || variant?.type !== "PER_CALL" || variant.amount?.currency !== "USD" || typeof variant.amount.value !== "number" || variant.amount.value < 0 || Math.round(variant.amount.value * 1_000_000) > maxMicroUsd) {
        throw new Error(`${name}: endpoint identity, method or price changed; no provider run was started.`);
      }
      return (await request("https://api.monid.ai/v1/run", { provider, endpoint, maxCost: maxMicroUsd / 1_000_000,
        input: { body: { ...body, route } } })).json();
    },
    getRun: async (runId: string) => {
      if (!/^[a-z0-9_-]{16,80}$/i.test(runId)) throw new Error("Invalid Monid run ID.");
      const response = await fetcher(`https://api.monid.ai/v1/runs/${runId}`, { signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new Error(`Monid result request failed (HTTP ${response.status}).`);
      return response.json();
    },
    mcpTools: async () => {
      const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
      const readRpc = async (response: Response) => {
        const text = await response.text();
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          const line = text.split("\n").find(l => l.startsWith("data: "));
          if (!line) throw new Error("Monid MCP returned no JSON-RPC result.");
          return JSON.parse(line.slice(6));
        }
        return JSON.parse(text);
      };
      const response = await request("https://mcp.monid.ai/v1", { jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "autofoundry-scout", version: "0.1.0" } } }, headers);
      const initialized = await readRpc(response);
      if (initialized.error) throw new Error("Monid MCP initialization was refused.");
      const session = response.headers.get("mcp-session-id");
      if (session) headers["Mcp-Session-Id"] = session;
      headers["MCP-Protocol-Version"] = initialized.result.protocolVersion;
      await request("https://mcp.monid.ai/v1", { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
      const listed = await readRpc(await request("https://mcp.monid.ai/v1", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers));
      if (listed.error || !Array.isArray(listed.result?.tools)) throw new Error("Monid MCP tool discovery failed.");
      return listed.result.tools;
    },
  };
}

// Inspected November 7. Prices are integer micro-USD per call for the pinned route.
export const READ_SOURCES = {
  github_issues: { provider: "anyapi", endpoint: "/github.search_issues", route: "chameleon", maxMicroUsd: 2400 },
  hackernews: { provider: "anyapi", endpoint: "/hackernews.search", route: "hedgehog", maxMicroUsd: 1500 },
  reddit: { provider: "anyapi", endpoint: "/reddit.search", route: "bison", maxMicroUsd: 350 },
  x_search: { provider: "anyapi", endpoint: "/twitter.search", route: "lynx", maxMicroUsd: 540 },
} as const;
