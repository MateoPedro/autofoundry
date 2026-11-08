import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export const ROLES = ["builder", "outreach", "closer"] as const;
export type Role = (typeof ROLES)[number];

// next.config.ts traces this folder into the /mcp function, so it exists on Vercel too. The reads
// below opt out of Turbopack's own tracing, which would otherwise ship the whole project.
export const TEMPLATE_DIR = join(process.cwd(), "templates", "child");

// Contract section 4: spawn fills these and nothing else. Outreach fills the other two per lead.
const FILLED = [
  "company_id",
  "slug",
  "inbox",
  "app_id",
  "app_url",
  "buyer",
  "sample",
  "product",
  "price",
  "channel",
  "delivery",
  "outreach_message",
  "follow_up_message",
] as const;
const PER_LEAD = ["lead_name", "sample_url"];
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export type TemplateValues = Record<(typeof FILLED)[number], string>;
export type AgentTemplate = { config: Record<string, unknown>; system: string };
export type ChildTemplate = Record<Role, AgentTemplate>;

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

function checkPlaceholders(file: string, value: unknown) {
  mapStrings(value, (text) => {
    for (const [, name] of text.matchAll(PLACEHOLDER)) {
      if (!(FILLED as readonly string[]).includes(name) && !PER_LEAD.includes(name)) throw new Error(`${file}: unknown placeholder {{${name}}}`);
    }
    return text;
  });
}

async function loadAgent(dir: string, role: Role): Promise<AgentTemplate> {
  const file = join(dir, "agents", `${role}.agent.yaml`);
  const { system_file, system, ...config } = parse(await readFile(/*turbopackIgnore: true*/ file, "utf8")) ?? {};
  const prompt = typeof system_file === "string" ? await readFile(/*turbopackIgnore: true*/ resolve(dirname(file), system_file), "utf8") : system;
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`${file}: needs system_file or system`);
  if (typeof config.model !== "string") throw new Error(`${file}: needs a model`);
  if (config.tools?.default_config?.permission !== "deny") throw new Error(`${file}: tools.default_config.permission must be deny`);
  checkPlaceholders(file, config);
  checkPlaceholders(file, prompt);
  return { config, system: prompt };
}

export async function loadChildTemplate(dir = TEMPLATE_DIR): Promise<ChildTemplate> {
  const [builder, outreach, closer] = await Promise.all(ROLES.map((role) => loadAgent(dir, role)));
  return { builder, outreach, closer };
}

// One pass, so an offer's own {{lead_name}} and {{sample_url}} survive for Outreach to fill.
export function fillAgent(template: AgentTemplate, values: TemplateValues): Record<string, unknown> {
  const fill = (text: string) => text.replace(PLACEHOLDER, (match, name: string) => (name in values ? values[name as keyof TemplateValues] : match));
  return { ...(mapStrings(template.config, fill) as Record<string, unknown>), system: fill(template.system) };
}
