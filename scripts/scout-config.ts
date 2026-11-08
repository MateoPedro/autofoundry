import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { AgentCreate, Session, SessionCreate } from "@usenaive-sdk/managed-agents";

export const SCOUT_OWNER = { project: "autofoundry", role: "scout" };
export const RUN_BUDGET_MICRO_USD = 300_000;
export const READ_TOOLS = ["data_search", "data_describe", "data_run", "web_search", "web_fetch"];

export async function loadScout(foundryApp?: string, path = resolve("agents/scout.agent.yaml")): Promise<AgentCreate> {
  const doc = parse(await readFile(path, "utf8"));
  const cap = doc.budget?.cap_micro_usd;
  const task = doc.budget?.max_task_micro_usd;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > 3_000_000 || !Number.isSafeInteger(task) || task < RUN_BUDGET_MICRO_USD || task > 500_000 || task > cap || doc.budget.period !== "day") {
    throw new Error("Scout budgets must be integer micro-USD: daily cap <= 3000000, task cap 300000..500000.");
  }
  if ("cap_usd" in doc.budget || "max_task_usd" in doc.budget) throw new Error("Use API micro-USD fields in Scout's config.");
  if (doc.name !== "scout" || doc.harness !== "pi" || !doc.model || doc.tools?.default_config?.permission !== "deny") {
    throw new Error("Scout must use name scout, harness pi, a model, and default deny.");
  }
  for (const [name, settings] of Object.entries(doc.tools.configs) as [string, {enabled: boolean; permission: string}][]) {
    if (!READ_TOOLS.includes(name) || settings.enabled !== true || settings.permission !== "allow") {
      throw new Error(`Unexpected Scout tool: ${name}`);
    }
  }
  if (doc.mcp_servers?.length || doc.skills?.length || doc.multiagent || doc.handoffs) throw new Error("Scout cannot delegate or load extra tools.");
  const { system_file, output_schema_file, ...config } = doc;
  const system = await readFile(resolve(dirname(path), system_file), "utf8");
  const output_schema = JSON.parse(await readFile(resolve(dirname(path), output_schema_file), "utf8"));
  if (foundryApp) {
    if (!/^app_[a-z0-9]+$/.test(foundryApp)) throw new Error("--foundry-app must be the verified app_ ID.");
    config.tools.configs.apps = { enabled: true, permission: "allow", config: { allowed_apps: [foundryApp], edits_apps: false } };
    for (const name of ["foundry.add_leads", "foundry.list_clusters"]) config.tools.configs[name] = { enabled: true, permission: "allow" };
  }
  return { ...config, metadata: { ...SCOUT_OWNER, persistence: foundryApp ? "foundry" : "local" }, system, output_schema,
    structured_output_required: true, mcp_servers: [], skills: [], multiagent: false, handoffs: false };
}

export async function prepareRun(requestId: string, agent: { id: string; version: number; mode: string }, focus: string, directory = resolve("var/scout/requests")) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error("Request ID must be 8..100 letters, digits, underscores or hyphens.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${requestId}.json`);
  const request: SessionCreate = { agent_id: agent.id, agent_version: agent.version, window: "immediate",
    budget_micro_usd: RUN_BUDGET_MICRO_USD,
    message: `Run one bounded scouting pass in ${agent.mode} mode. Current UTC: ${new Date().toISOString()}. Return the required structured output. Never contact anyone.\nFocus: ${focus}`,
    metadata: { ...SCOUT_OWNER, request_id: requestId, persistence: agent.mode, focus },
  };
  try { await writeFile(path, JSON.stringify(request), { flag: "wx", mode: 0o600 }); return request; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const saved = JSON.parse(await readFile(path, "utf8")) as SessionCreate;
    if (saved.agent_id !== agent.id || saved.agent_version !== agent.version || saved.metadata?.focus !== focus || saved.metadata?.persistence !== agent.mode || saved.budget_micro_usd !== RUN_BUDGET_MICRO_USD || saved.window !== "immediate") {
      throw new Error("Request ID already belongs to a different Scout run. Use a new request ID.");
    }
    return saved;
  }
}

type Evidence = { url: string; observation: string };
type Lead = { name: string; url: string | null; contact_url: string | null; email: string | null; external_id: string;
  data: Record<string, unknown> & { evidence: Evidence[]; issues: string[]; observed_at: string; discovery_query: string } };
export type ScoutOutput = { batches: { cluster: { label: string; source: string; unserved_score: number }; leads: Lead[] }[]; notes: string[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
export function monidSourceContext(source: unknown) {
  if (!object(source) || source.status !== "COMPLETED" || !object(source.providerResponse) || typeof source.providerResponse.httpStatus !== "number" || source.providerResponse.httpStatus < 200 || source.providerResponse.httpStatus >= 300 || source.provider !== "twitterdata.io" || source.endpoint !== "/tweets/search" || !nonempty(source.runId) || !object(source.output) || !Array.isArray(source.output.data)) {
    throw new Error("Source must be a successful bounded Monid X read with a post array.");
  }
  const posts = source.output.data.slice(0, 10).map((post: unknown) => {
    if (!object(post) || !nonempty(post.tweet_id) || !nonempty(post.url) || !nonempty(post.text)) throw new Error("Monid post is missing its identity, URL or text.");
    const author = object(post.author) ? post.author : {};
    return { post_id: post.tweet_id, url: post.url, text: post.text.slice(0, 2000), text_truncated: post.text.length > 2000,
      created_at: post.created_at, author: { user_id: author.user_id, username: author.username, name: author.name } };
  });
  const context = JSON.stringify({ run_id: source.runId, provider: source.provider, endpoint: source.endpoint, created_at: source.createdAt,
    billing: source.billing, posts });
  if (context.length > 25000) throw new Error("Source exceeds 25000 characters; use a smaller bounded read.");
  return context;
}
function publicUrl(v: unknown) {
  if (!nonempty(v)) return false;
  try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}

export function validateOutput(value: unknown): asserts value is ScoutOutput {
  const invalid = () => { throw new Error("Scout output is invalid; artifact was not accepted. Inspect the session before retrying."); };
  if (!object(value) || Object.keys(value).some(k => !["batches", "notes"].includes(k)) || !Array.isArray(value.batches) || value.batches.length > 2 || !Array.isArray(value.notes) || value.notes.length > 20 || value.notes.some(n => typeof n !== "string" || n.length > 2000)) return invalid();
  const labels = new Set();
  for (const batch of value.batches) {
    if (!object(batch) || Object.keys(batch).some(k => !["cluster", "leads"].includes(k)) || !object(batch.cluster) || !Array.isArray(batch.leads) || !batch.leads.length || batch.leads.length > 10) return invalid();
    const c = batch.cluster;
    if (Object.keys(c).some(k => !["label", "source", "unserved_score"].includes(k)) || !nonempty(c.label) || c.label.length > 200 || !nonempty(c.source) || c.source.length > 100 || typeof c.unserved_score !== "number" || !Number.isFinite(c.unserved_score) || c.unserved_score < 0 || c.unserved_score > 1 || labels.has(c.label)) return invalid();
    labels.add(c.label);
    const ids = new Set();
    for (const l of batch.leads) {
      if (!object(l) || Object.keys(l).some(k => !["name", "url", "contact_url", "email", "external_id", "data"].includes(k)) || !nonempty(l.name) || l.name.length > 300 || !nonempty(l.external_id) || l.external_id.length > 1000 || ids.has(l.external_id)) return invalid();
      ids.add(l.external_id);
      if (l.url !== null && !publicUrl(l.url)) return invalid();
      if (l.contact_url !== null && !publicUrl(l.contact_url)) return invalid();
      if (l.email !== null && (typeof l.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email))) return invalid();
      if (!l.contact_url && !l.email) return invalid();
      const d = l.data;
      if (!object(d) || !nonempty(d.discovery_query) || !nonempty(d.observed_at) || !/^\d{4}-\d\d-\d\dT.*(?:Z|\+00:00)$/.test(d.observed_at) || !Number.isFinite(Date.parse(d.observed_at)) || !Array.isArray(d.issues) || d.issues.some(i => typeof i !== "string") || !Array.isArray(d.evidence) || !d.evidence.length || d.evidence.length > 10) return invalid();
      if (d.evidence.some(e => !object(e) || !publicUrl(e.url) || !nonempty(e.observation) || e.observation.length > 2000)) return invalid();
    }
  }
}

export async function saveSession(session: Pick<Session, "id" | "agent_id" | "agent_version" | "status" | "stop_reason" | "consumed_micro_usd" | "structured_output" | "created_at">, directory = resolve("var/scout")) {
  if (!["idle", "completed"].includes(session.status) || session.stop_reason !== "end_turn") throw new Error(`Session ${session.id} is ${session.status}/${session.stop_reason}; collect after a clean end_turn.`);
  validateOutput(session.structured_output);
  if (!/^ses_[a-z0-9]+$/.test(session.id)) throw new Error("Unexpected session ID.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${session.id}.json`);
  const content = JSON.stringify({ session_id: session.id, agent_id: session.agent_id, agent_version: session.agent_version,
    created_at: session.created_at, consumed_micro_usd: session.consumed_micro_usd, ...session.structured_output }, null, 2) + "\n";
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || await readFile(path, "utf8") !== content) throw error;
  }
  return path;
}
