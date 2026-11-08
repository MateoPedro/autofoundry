import type { AgentSpend, SpendSource } from "./foundry/tool";

const REQUEST_TIMEOUT_MS = 3_000;
const CONCURRENCY = 5;

// Reads every agent's spend with the app's own Naïve key. Returns null until the owner has
// approved a key for the app, and get_metrics then reports spend_stale instead of failing.
export function createSpendSource(env: NodeJS.ProcessEnv): SpendSource | null {
  const apiKey = env.NAIVE_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = env.NAIVE_API_BASE_URL || env.NAIVE_API_URL || "https://api.vetta.sh";

  return {
    async listAgentSpend() {
      const { createClient } = await import("@usenaive-sdk/managed-agents");
      const client = createClient({
        baseUrl,
        apiKey,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      });

      const agents: { id: string; name: string }[] = [];
      let after: string | undefined;
      do {
        const page = await client.agents.list({ limit: 100, after });
        agents.push(...page.data.map((a) => ({ id: a.id, name: a.name })));
        after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      } while (after);

      const out: AgentSpend[] = [];
      for (let i = 0; i < agents.length; i += CONCURRENCY) {
        const batch = agents.slice(i, i + CONCURRENCY);
        const spends = await Promise.all(batch.map((a) => client.agents.spend(a.id)));
        batch.forEach((a, j) => out.push({ agent_id: a.id, agent_name: a.name, micro_usd: spends[j].spent_micro_usd }));
      }
      return out;
    },
  };
}
