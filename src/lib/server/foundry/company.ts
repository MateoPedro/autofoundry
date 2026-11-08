import { z } from "zod";
import type { Db } from "../db";
import { newId } from "../ids";
import { describe, formatPrice } from "./metrics";
import { fillAgent, ROLES, type ChildTemplate, type Role } from "./templates";
import { defineTool, ToolError, type Budget, type NaiveWriter, type ToolContext } from "./tool";

const reason = z.string().trim().min(1).max(500);
const ZERO: Budget = { cap_micro_usd: 0, max_task_micro_usd: 0, period: "month" };
const CARD_CONCURRENCY = 5;
// Follow-ups are due 20 hours after the first message, so every 2 hours sends each within 22.
export const FOLLOW_UP_CRON = "0 */2 * * *";

type Company = { id: string; slug: string; status: string; offer_id: string; cluster_id: string };
type Resource = { kind: string; role: string | null; naive_id: string; name: string | null };
type Offer = {
  buyer: string;
  sample: string;
  product: string;
  price_cents: number;
  channel: string;
  delivery: string;
  outreach_message: string;
  follow_up_message: string | null;
};

export function requireNaive(ctx: ToolContext): NaiveWriter {
  if (!ctx.naive) throw new ToolError("internal", "the foundry has no NAIVE_WRITE_KEY; the owner runs pnpm foundry:key and redeploys");
  return ctx.naive;
}

export async function naiveStep<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    console.error(`naive call failed: ${what}`, error);
    throw new ToolError("naive_error", `${what}: ${describe(error)}`);
  }
}

async function resources(db: Db, companyId: string) {
  return db.query<Resource>("select kind, role, naive_id, name from company_resources where company_id = $1 order by created_at", [companyId]);
}

export async function agentsOf(db: Db, companyId: string) {
  return db.query<{ role: Role; naive_id: string; name: string }>(
    "select role, naive_id, name from company_resources where company_id = $1 and kind = 'agent' order by created_at",
    [companyId],
  );
}

async function loadTemplate(ctx: ToolContext): Promise<ChildTemplate> {
  try {
    return await ctx.childTemplate();
  } catch (error) {
    console.error("child templates failed to load", error);
    throw new ToolError("internal", "the child templates in templates/child are missing or invalid; the foundry logged the details");
  }
}

// Finds the company for this request_id, or admits a new one under the policy and reserves its leads.
async function admit(db: Db, input: { request_id: string; offer_id: string; lead_count: number; parent_id?: string | null; reason: string }) {
  return db.tx(async (tx) => {
    const [policy] = await tx.query<{ max_proposed: number }>("select max_proposed from funding_policy for update");
    const [existing] = await tx.query<Company>("select id, slug, status, offer_id, cluster_id from companies where request_id = $1", [input.request_id]);
    if (existing) {
      if (existing.offer_id !== input.offer_id) throw new ToolError("conflict", `request_id ${input.request_id} already spawned from offer ${existing.offer_id}`);
      return existing;
    }

    const [offer] = await tx.query<{ review_status: string; cluster_id: string }>("select review_status, cluster_id from offers where id = $1", [input.offer_id]);
    if (!offer) throw new ToolError("not_found", `no offer ${input.offer_id}`);
    if (offer.review_status !== "approved") throw new ToolError("not_approved", `offer ${input.offer_id} is ${offer.review_status}`);
    if (input.parent_id) {
      const [parent] = await tx.query("select 1 from companies where id = $1", [input.parent_id]);
      if (!parent) throw new ToolError("not_found", `no company ${input.parent_id}`);
    }
    const [{ waiting }] = await tx.query<{ waiting: unknown }>("select count(*) as waiting from companies where status in ('spawning', 'proposed')");
    if (Number(waiting) >= policy.max_proposed) {
      throw new ToolError("policy", `max_proposed: ${policy.max_proposed} companies are already waiting for funding`);
    }

    const [{ next }] = await tx.query<{ next: unknown }>(
      "select coalesce(max(substring(slug from 4)::int), 0) + 1 as next from companies where slug ~ '^co-[0-9]+$'",
    );
    const company: Company = {
      id: newId("co"),
      slug: `co-${String(next).padStart(2, "0")}`,
      status: "spawning",
      offer_id: input.offer_id,
      cluster_id: offer.cluster_id,
    };
    await tx.query("insert into companies (id, slug, offer_id, cluster_id, parent_id, status, request_id) values ($1, $2, $3, $4, $5, 'spawning', $6)", [
      company.id,
      company.slug,
      company.offer_id,
      company.cluster_id,
      input.parent_id ?? null,
      input.request_id,
    ]);
    const leads = await tx.query(
      `update leads set company_id = $1, status = 'assigned'
       where id in (select id from leads where cluster_id = $2 and company_id is null and status = 'new'
                    order by created_at, id limit $3 for update skip locked)
       returning id`,
      [company.id, company.cluster_id, input.lead_count],
    );
    if (!leads.length) throw new ToolError("invalid", `cluster ${company.cluster_id} has no leads that another company hasn't taken`);
    await tx.query("insert into decisions (id, agent, kind, cluster_id, offer_id, company_id, reason) values ($1, 'creator', 'spawn', $2, $3, $4, $5)", [
      newId("dc"),
      company.cluster_id,
      company.offer_id,
      company.id,
      input.reason,
    ]);
    return company;
  });
}

export function placeholderPage(slug: string): Record<string, string> {
  return { "index.html": `<!doctype html><meta charset="utf-8"><title>${slug}</title><p>${slug}</p>\n` };
}

// Each Naïve resource goes into company_resources as soon as it exists, so a retry skips it.
async function build(db: Db, naive: NaiveWriter, template: ChildTemplate, company: Company) {
  const have = await resources(db, company.id);
  const find = (kind: string, role: string | null = null) => have.find((r) => r.kind === kind && r.role === role);
  const record = async (kind: string, role: string | null, naiveId: string, name: string | null) => {
    await db.query("insert into company_resources (company_id, kind, role, naive_id, name) values ($1, $2, $3, $4, $5) on conflict do nothing", [
      company.id,
      kind,
      role,
      naiveId,
      name,
    ]);
    const row = { kind, role, naive_id: naiveId, name };
    have.push(row);
    return row;
  };

  const [offer] = await db.query<Offer>(
    "select buyer, sample, product, price_cents, channel, delivery, outreach_message, follow_up_message from offers where id = $1",
    [company.offer_id],
  );

  const identity =
    find("identity") ??
    (await record(
      "identity",
      null,
      (
        await naiveStep("create the identity", () =>
          naive.createIdentity({ name: company.slug, description: offer.product, metadata: { project: "autofoundry", company_id: company.id } }),
        )
      ).id,
      company.slug,
    ));

  const app = find("app") ?? (await record("app", null, (await naiveStep("create the app", () => naive.createApp({ name: company.slug, description: offer.product }))).id, null));
  if (!app.name) {
    const { url } = await naiveStep("deploy the app's first page", () => naive.deployApp(app.naive_id, placeholderPage(company.slug)));
    await db.query("update company_resources set name = $3 where company_id = $1 and kind = 'app' and naive_id = $2", [company.id, app.naive_id, url]);
    app.name = url;
  }

  const inbox = find("inbox")?.name ?? `${company.slug}@${await naiveStep("find the system email domain", () => naive.systemDomain())}`;
  const values = {
    company_id: company.id,
    slug: company.slug,
    inbox,
    app_id: app.naive_id,
    app_url: app.name,
    buyer: offer.buyer,
    sample: offer.sample,
    product: offer.product,
    price: formatPrice(offer.price_cents),
    channel: offer.channel,
    delivery: offer.delivery,
    outreach_message: offer.outreach_message,
    follow_up_message: offer.follow_up_message ?? "",
  };

  for (const role of ROLES) {
    if (find("agent", role)) continue;
    const name = `${company.slug}-${role}`;
    const filled = fillAgent(template[role], values);
    const metadata = { ...((filled.metadata as Record<string, unknown> | undefined) ?? {}), project: "autofoundry", company_id: company.id, role };
    const existing = await naiveStep(`look up agent ${name}`, () => naive.findAgent(name));
    if (existing && existing.metadata.company_id !== company.id) throw new ToolError("conflict", `an agent named ${name} already exists for something else`);
    const id = existing?.id ?? (await naiveStep(`create agent ${name}`, () => naive.createAgent({ ...filled, name, budget: ZERO, metadata }))).id;
    await record("agent", role, id, name);
  }
  const agents = Object.fromEntries(ROLES.map((role) => [role, find("agent", role)!])) as Record<Role, Resource>;

  // An inbox's owner must hold the identity first, and Outreach sends email as it too.
  for (const role of ROLES) {
    await naiveStep(`attach the identity to ${agents[role].name}`, () => naive.attachIdentity(agents[role].naive_id, identity.naive_id));
  }
  if (!find("inbox")) {
    const existing = await naiveStep("look up the inbox", () => naive.findInbox(identity.naive_id, inbox));
    const id =
      existing?.id ??
      (await naiveStep("create the inbox", () => naive.createInbox(identity.naive_id, { address: inbox, owning_agent_id: agents.closer.naive_id }))).id;
    await record("inbox", null, id, inbox);
  }

  // A card assigned to a zero-cap Builder is parked as blocked until fund raises the cap.
  // The key makes the create idempotent on Naïve's side too.
  const leads = await db.query<{ id: string; name: string; url: string | null; contact_url: string | null; email: string | null; data: unknown }>(
    "select id, name, url, contact_url, email, data from leads where company_id = $1 order by created_at, id",
    [company.id],
  );
  const missing = leads.filter((lead) => !have.some((r) => r.kind === "card" && r.name === lead.id));
  if (missing.length) {
    const board = await naiveStep("open the Builder's board", () => naive.ensureBoard(agents.builder.naive_id));
    for (let i = 0; i < missing.length; i += CARD_CONCURRENCY) {
      await Promise.all(
        missing.slice(i, i + CARD_CONCURRENCY).map(async (lead) => {
          const body = JSON.stringify({ lead_id: lead.id, name: lead.name, url: lead.url, contact_url: lead.contact_url, email: lead.email, data: lead.data });
          const card = await naiveStep(`create the card for lead ${lead.id}`, () =>
            naive.createCard(board.id, { title: lead.name, body, assignee: agents.builder.name!, key: `${company.id}:${lead.id}` }),
          );
          await record("card", null, card.id, lead.id);
        }),
      );
    }
  }

  if (offer.follow_up_message !== null && !find("deployment", "outreach")) {
    const outreach = agents.outreach;
    const existing = await naiveStep("look up the follow-up schedule", () => naive.findDeployment(outreach.naive_id));
    const id =
      existing?.id ??
      (
        await naiveStep("create the follow-up schedule", () =>
          naive.createDeployment({
            agent_id: outreach.naive_id,
            cron: FOLLOW_UP_CRON,
            identity: identity.naive_id,
            input_template: `Scheduled follow-up run for company ${company.id}. Call foundry.follow_ups_due with company_id ${company.id}. Send each lead it returns the follow-up message from your instructions, once, then log it. If it returns no leads, end your turn without doing anything else.`,
          }),
        )
      ).id;
    await record("deployment", "outreach", id, FOLLOW_UP_CRON);
  }
}

async function deploymentsOf(db: Db, companyId: string) {
  return db.query<{ naive_id: string }>("select naive_id from company_resources where company_id = $1 and kind = 'deployment'", [companyId]);
}

async function spawnSummary(db: Db, company: Company) {
  const rows = await resources(db, company.id);
  const [{ status }] = await db.query<{ status: string }>("select status from companies where id = $1", [company.id]);
  return {
    company_id: company.id,
    slug: company.slug,
    status,
    agents: rows.filter((r) => r.kind === "agent").map((r) => r.name),
    cards: rows.filter((r) => r.kind === "card").length,
    app_url: rows.find((r) => r.kind === "app")?.name ?? null,
    inbox: rows.find((r) => r.kind === "inbox")?.name ?? null,
  };
}

export const spawn = defineTool({
  name: "spawn",
  description:
    "Creator only. Spawn a company from an approved offer: its identity, app, Builder, Outreach and Closer agents with zero budgets, inbox, and one Builder card per lead (the oldest lead_count leads in the cluster that no company has). It starts proposed and runs nothing until Funder funds it. request_id is any string unique to this decision; if spawn fails, call it again with the same request_id to resume.",
  input: z.object({
    request_id: z.string().trim().min(1).max(200),
    offer_id: z.string().min(1),
    lead_count: z.number().int().min(1).max(25).default(10),
    parent_id: z.string().min(1).nullish(),
    reason,
  }),
  async run(ctx, input) {
    const naive = requireNaive(ctx);
    const template = await loadTemplate(ctx);
    const company = await admit(ctx.db, input);
    if (company.status === "killed") throw new ToolError("killed", `company ${company.id} from this request_id was killed`);
    if (company.status === "proposed" || company.status === "active") return spawnSummary(ctx.db, company);

    await ctx.db.query("update companies set status = 'spawning' where id = $1 and status = 'failed'", [company.id]);
    try {
      await build(ctx.db, naive, template, company);
    } catch (error) {
      await ctx.db.query("update companies set status = 'failed' where id = $1 and status = 'spawning'", [company.id]);
      if (error instanceof ToolError && error.code === "naive_error") {
        throw new ToolError("naive_error", `spawn stopped at "${error.message}"; company ${company.id} is failed until spawn is called again with the same request_id`);
      }
      throw error;
    }
    await ctx.db.query("update companies set status = 'proposed' where id = $1 and status = 'spawning'", [company.id]);
    return spawnSummary(ctx.db, company);
  },
});

// Cards Naïve parked because their agent had no budget sit blocked with nothing blocking them.
async function resumeParkedCards(naive: NaiveWriter, agents: { naive_id: string; name: string }[]) {
  let resumed = 0;
  for (const agent of agents) {
    const cards = await naiveStep(`list ${agent.name}'s cards`, () => naive.cardsOf(agent.naive_id));
    for (const card of cards.filter((c) => c.status === "blocked" && c.blocked_by.length === 0)) {
      await naiveStep(`resume card ${card.id}`, () => naive.setCardStatus(card.board_id, card.id, "todo"));
      resumed++;
    }
  }
  return resumed;
}

export const fund = defineTool({
  name: "fund",
  description:
    "Funder only. Grant one grant from the pool to a proposed or active company. The grant is split across its agents by the policy's budget_split and raises each agent's monthly budget cap; the first grant makes the company active and starts its Builder on the lead cards. Refused if it would pass the pool, the company's grant count, or max_active.",
  input: z.object({ company_id: z.string().min(1), reason }),
  async run(ctx, input) {
    const naive = requireNaive(ctx);
    return ctx.db.tx(async (db) => {
      const [policy] = await db.query<{
        pool_micro_usd: unknown;
        grant_micro_usd: unknown;
        max_grants_per_company: number;
        max_active: number;
        budget_split: Record<string, number>;
      }>("select pool_micro_usd, grant_micro_usd, max_grants_per_company, max_active, budget_split from funding_policy for update");
      const [company] = await db.query<{ status: string; granted_micro_usd: unknown }>(
        "select status, granted_micro_usd from companies where id = $1 for update",
        [input.company_id],
      );
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is killed`);
      if (company.status !== "proposed" && company.status !== "active") {
        throw new ToolError("conflict", `company ${input.company_id} is ${company.status}; spawn has to finish before it can be funded`);
      }

      const pool = Number(policy.pool_micro_usd);
      const grant = Number(policy.grant_micro_usd);
      const [{ granted }] = await db.query<{ granted: unknown }>("select coalesce(sum(granted_micro_usd), 0) as granted from companies");
      const poolLeft = pool - Number(granted);
      if (grant > poolLeft) throw new ToolError("policy", `pool: a grant is ${grant} micro-USD and the pool has ${poolLeft} left`);
      const [{ grants }] = await db.query<{ grants: unknown }>("select count(*) as grants from decisions where company_id = $1 and kind = 'fund'", [input.company_id]);
      if (Number(grants) >= policy.max_grants_per_company) {
        throw new ToolError("policy", `max_grants_per_company: ${input.company_id} already has ${policy.max_grants_per_company} grants`);
      }
      if (company.status === "proposed") {
        const [{ active }] = await db.query<{ active: unknown }>("select count(*) as active from companies where status = 'active'");
        if (Number(active) >= policy.max_active) throw new ToolError("policy", `max_active: ${policy.max_active} companies are already active`);
      }

      // Caps are set to each role's share of everything granted so far, not raised by a delta,
      // so a retry after a failed call sets the same caps instead of adding twice.
      const agents = await agentsOf(db, input.company_id);
      const total = Number(company.granted_micro_usd) + grant;
      const caps = [];
      for (const role of ROLES.filter((r) => r in policy.budget_split)) {
        const share = policy.budget_split[role];
        const agent = agents.find((a) => a.role === role);
        if (!agent) throw new ToolError("conflict", `company ${input.company_id} has no ${role} agent`);
        const cap = Math.round(total * share);
        await naiveStep(`raise ${agent.name}'s cap`, () => naive.setBudget(agent.naive_id, { cap_micro_usd: cap, max_task_micro_usd: cap, period: "month" }));
        caps.push({ name: agent.name, cap_micro_usd: cap });
      }
      const cardsResumed = await resumeParkedCards(naive, agents);
      for (const deployment of await deploymentsOf(db, input.company_id)) {
        await naiveStep("turn on the follow-up schedule", () => naive.setDeploymentEnabled(deployment.naive_id, true));
      }

      await db.query("update companies set granted_micro_usd = $2, status = 'active', funded_at = coalesce(funded_at, now()) where id = $1", [
        input.company_id,
        total,
      ]);
      await db.query("insert into decisions (id, agent, kind, company_id, amount_micro_usd, reason) values ($1, 'funder', 'fund', $2, $3, $4)", [
        newId("dc"),
        input.company_id,
        grant,
        input.reason,
      ]);
      return {
        company_id: input.company_id,
        status: "active",
        granted_micro_usd: total,
        pool_left_micro_usd: poolLeft - grant,
        agents: caps,
        cards_resumed: cardsResumed,
      };
    });
  },
});

export const kill = defineTool({
  name: "kill",
  description:
    "Funder only. Kill a company: set every one of its agents' budgets to zero, check Naïve shows zero, and mark it killed with a one-line reason. Its sites, leads and history stay. Unspent grant money doesn't return to the pool.",
  input: z.object({ company_id: z.string().min(1), reason }),
  async run(ctx, input) {
    const naive = requireNaive(ctx);
    // The row lock keeps a concurrent fund from raising caps between the zeroing and the status change.
    return ctx.db.tx(async (db) => {
      const [company] = await db.query<{ status: string }>("select status from companies where id = $1 for update", [input.company_id]);
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is already killed`);

      const agents = await agentsOf(db, input.company_id);
      for (const agent of agents) {
        await naiveStep(`zero ${agent.name}'s cap`, () => naive.setBudget(agent.naive_id, ZERO));
        const budget = await naiveStep(`read ${agent.name}'s budget back`, () => naive.getBudget(agent.naive_id));
        if (budget.cap_micro_usd !== 0 || budget.max_task_micro_usd !== 0) {
          throw new ToolError("naive_error", `${agent.name} still has a cap of ${budget.cap_micro_usd} micro-USD after zeroing it`);
        }
      }
      for (const deployment of await deploymentsOf(db, input.company_id)) {
        await naiveStep("turn off the follow-up schedule", () => naive.setDeploymentEnabled(deployment.naive_id, false));
      }
      await db.query("update companies set status = 'killed', killed_at = now() where id = $1", [input.company_id]);
      await db.query("insert into decisions (id, agent, kind, company_id, reason) values ($1, 'funder', 'kill', $2, $3)", [
        newId("dc"),
        input.company_id,
        input.reason,
      ]);
      return { company_id: input.company_id, status: "killed", agents_stopped: agents.length };
    });
  },
});
