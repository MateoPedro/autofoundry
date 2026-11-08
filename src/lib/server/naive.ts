import type { AgentCreate } from "@usenaive-sdk/managed-agents";
import type { AgentSpend, NaiveWriter, SpendSource } from "./foundry/tool";

const REQUEST_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_URL = "https://api.vetta.sh";
const CONCURRENCY = 5;

// Reading an agent's spend needs billing:read. The write key (NAIVE_WRITE_KEY, from
// pnpm foundry:key) has it; the app's approved key (NAIVE_API_KEY) can only be read-only.
export function spendCredentials(env: Partial<Record<string, string>>): { apiKey: string; baseUrl: string } | null {
  const apiKey = env.NAIVE_WRITE_KEY?.trim() || env.NAIVE_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseUrl: env.NAIVE_API_BASE_URL || env.NAIVE_API_URL || DEFAULT_BASE_URL };
}

// Returns null when the app holds no key, and get_metrics then reports spend_stale instead of failing.
export function createSpendSource(env: NodeJS.ProcessEnv): SpendSource | null {
  const credentials = spendCredentials(env);
  if (!credentials) return null;
  const { apiKey, baseUrl } = credentials;

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

async function writeClient(apiKey: string, baseUrl: string) {
  const { createClient } = await import("@usenaive-sdk/managed-agents");
  return createClient({
    baseUrl,
    apiKey,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) }),
  });
}

async function allPages<T>(list: (after: string | undefined) => Promise<{ data: T[]; has_more: boolean; next_cursor: string | null }>) {
  const out: T[] = [];
  let after: string | undefined;
  do {
    const page = await list(after);
    out.push(...page.data);
    after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (after);
  return out;
}

// spawn, fund and kill need agents:write, which only the org key in NAIVE_WRITE_KEY has.
// Returns null without it, and those tools then refuse.
export function createNaiveWriter(env: NodeJS.ProcessEnv): NaiveWriter | null {
  const apiKey = env.NAIVE_WRITE_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = env.NAIVE_API_BASE_URL || env.NAIVE_API_URL || DEFAULT_BASE_URL;
  let pending: ReturnType<typeof writeClient> | undefined;
  const client = () => (pending ??= writeClient(apiKey, baseUrl));

  return {
    async systemDomain() {
      const domains = await (await client()).domains.list();
      const domain = domains.data.find((d) => d.kind === "system" && d.status === "active");
      if (!domain) throw new Error("the organization has no active system email domain");
      return domain.name;
    },
    async createIdentity(body) {
      return (await client()).identities.create(body);
    },
    async createApp(body) {
      return (await client()).apps.create({ ...body, type: "frontend_only" });
    },
    // A frontend_only app has no url until its first deploy, and the deploy answers with a
    // per-deployment url, so the app's own url is read back afterwards.
    async deployApp(appId, files) {
      const c = await client();
      const encoded = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString("base64")]));
      await c.apps.deploy(appId, encoded);
      const app = await c.apps.get(appId);
      if (!app.url) throw new Error(`app ${appId} has no url after its first deploy`);
      return { url: app.url };
    },
    async findAgent(name) {
      const c = await client();
      const agents = await allPages((after) => c.agents.list({ limit: 100, after }));
      const agent = agents.find((a) => a.name === name);
      return agent ? { id: agent.id, metadata: agent.metadata } : null;
    },
    async createAgent(config) {
      return (await client()).agents.create(config as unknown as AgentCreate);
    },
    async attachIdentity(agentId, identityId) {
      await (await client()).identities.attach(agentId, identityId);
    },
    async findInbox(identityId, address) {
      const inboxes = await (await client()).emails.list(identityId, { limit: 100 });
      const inbox = inboxes.data.find((i) => i.address === address);
      return inbox ? { id: inbox.id } : null;
    },
    async createInbox(identityId, body) {
      return (await client()).emails.create(identityId, body);
    },
    async ensureBoard(agentId) {
      return (await client()).board.create(agentId);
    },
    async createCard(boardId, card) {
      return (await client()).board.cards.create(boardId, card);
    },
    // Naïve refuses a partial budget, so every patch sends all three fields.
    async setBudget(agentId, budget) {
      await (await client()).agents.update(agentId, { budget });
    },
    async getBudget(agentId) {
      return (await (await client()).agents.get(agentId)).budget;
    },
    async cardsOf(agentId) {
      const c = await client();
      return allPages((after) => c.board.cards.ofAgent(agentId, { limit: 100, after }));
    },
    async setCardStatus(boardId, cardId, status) {
      await (await client()).board.cards.update(boardId, cardId, { status });
    },
  };
}
