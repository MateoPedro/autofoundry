import type { AgentSpend, SpendSource } from "./foundry/tool";

// Reads every agent's spend with the app's own Naïve key. Returns null until the owner has
// approved a key for the app, and get_metrics then reports spend_stale instead of failing.
export function createSpendSource(env: NodeJS.ProcessEnv): SpendSource | null {
  const apiKey = env.NAIVE_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = env.NAIVE_API_BASE_URL || "https://api.vetta.sh";

  return {
    async listAgentSpend() {
      const { createClient } = await import("@usenaive-sdk/managed-agents");
      const client = createClient({ baseUrl, apiKey });
      const out: AgentSpend[] = [];
      let after: string | undefined;
      do {
        const page = await client.agents.list({ limit: 100, after });
        for (const agent of page.data) {
          const spend = await client.agents.spend(agent.id);
          out.push({ agent_id: agent.id, agent_name: agent.name, micro_usd: spend.spent_micro_usd });
        }
        after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      } while (after);
      return out;
    },
  };
}
