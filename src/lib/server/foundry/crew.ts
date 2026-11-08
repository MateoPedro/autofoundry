import { z } from "zod";
import { newId } from "../ids";
import { naiveStep, placeholderPage, requireNaive } from "./company";
import { requireCompany } from "./leads";
import { defineTool, ToolError } from "./tool";

const FOLLOW_UP_AFTER_MS = 20 * 60 * 60_000;

export const publishSample = defineTool({
  name: "publish_sample",
  description:
    "Builder or Closer. Publish one lead's sample as a single self-contained HTML page (inline CSS, no scripts) at <app_url>/<lead_id>. The foundry redeploys the company's site with every published page, records a sample_delivered touch, and the first time hands the lead to Outreach with a card. Publishing again replaces that lead's page.",
  input: z.object({
    company_id: z.string().min(1),
    lead_id: z.string().min(1),
    agent_name: z.string().min(1).max(100),
    html: z.string().min(1).max(100_000),
  }),
  async run(ctx, input) {
    const naive = requireNaive(ctx);
    // The row lock serializes a company's publishes, so no deploy ships without a page another just stored.
    return ctx.db.tx(async (db) => {
      const [company] = await db.query<{ slug: string; status: string }>("select slug, status from companies where id = $1 for update", [input.company_id]);
      if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
      if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is killed and takes no more work`);
      if (company.status !== "active") throw new ToolError("conflict", `company ${input.company_id} is ${company.status}, not active`);
      const [lead] = await db.query<{ id: string; name: string; url: string | null; contact_url: string | null; email: string | null; status: string }>(
        "select id, name, url, contact_url, email, status from leads where id = $1 and company_id = $2",
        [input.lead_id, input.company_id],
      );
      if (!lead) throw new ToolError("not_found", `no lead ${input.lead_id} in company ${input.company_id}`);

      const resources = await db.query<{ kind: string; role: string | null; naive_id: string; name: string | null }>(
        "select kind, role, naive_id, name from company_resources where company_id = $1 and kind in ('app', 'agent')",
        [input.company_id],
      );
      const app = resources.find((r) => r.kind === "app");
      const builder = resources.find((r) => r.role === "builder");
      const outreach = resources.find((r) => r.role === "outreach");
      if (!app?.name || !builder || !outreach) throw new ToolError("conflict", `company ${input.company_id} has no app, Builder or Outreach`);

      await db.query(
        `insert into samples (lead_id, company_id, html) values ($1, $2, $3)
         on conflict (lead_id) do update set html = excluded.html, updated_at = now()`,
        [lead.id, input.company_id, input.html],
      );
      const pages = await db.query<{ lead_id: string; html: string }>("select lead_id, html from samples where company_id = $1", [input.company_id]);
      const files = { ...placeholderPage(company.slug), ...Object.fromEntries(pages.map((p) => [`${p.lead_id}/index.html`, p.html])) };
      await naiveStep("deploy the company's site", () => naive.deployApp(app.naive_id, files));

      const sampleUrl = `${app.name}/${lead.id}`;
      await db.query("update leads set sample_url = $2 where id = $1", [lead.id, sampleUrl]);
      await db.query(
        "insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail) values ($1, $2, $3, $4, (select channel from offers o join companies c on c.offer_id = o.id where c.id = $2), 'sample_delivered', $5)",
        [newId("tc"), input.company_id, lead.id, input.agent_name, sampleUrl],
      );

      // Only a lead nobody has contacted goes to Outreach. The key keeps a republish from waking it twice.
      let handedTo: string | null = null;
      if (lead.status === "assigned") {
        const board = await naiveStep("open the Builder's board", () => naive.ensureBoard(builder.naive_id));
        const body = JSON.stringify({ lead_id: lead.id, name: lead.name, url: lead.url, contact_url: lead.contact_url, email: lead.email, sample_url: sampleUrl });
        const card = await naiveStep("hand the lead to Outreach", () =>
          naive.createCard(board.id, { title: `Contact: ${lead.name}`, body, assignee: outreach.name!, key: `${input.company_id}:${lead.id}:outreach` }),
        );
        await db.query("insert into company_resources (company_id, kind, naive_id, name) values ($1, 'card', $2, $3) on conflict do nothing", [
          input.company_id,
          card.id,
          `${lead.id}:outreach`,
        ]);
        handedTo = outreach.name;
      }
      return { lead_id: lead.id, sample_url: sampleUrl, handed_to: handedTo };
    });
  },
});

export const followUpsDue = defineTool({
  name: "follow_ups_due",
  description:
    "Outreach only. The company's leads that got the first message at least 20 hours ago, haven't replied, and haven't had the follow-up, oldest first. Send each the follow-up once, then log it with log_touch as kind sent and detail 'follow-up'.",
  input: z.object({ company_id: z.string().min(1), limit: z.number().int().min(1).max(25).default(10) }),
  async run(ctx, input) {
    await requireCompany(ctx.db, input.company_id);
    const cutoff = new Date(ctx.now().getTime() - FOLLOW_UP_AFTER_MS);
    const leads = await ctx.db.query<{ sent_at: Date }>(
      `select l.id, l.name, l.url, l.contact_url, l.email, l.sample_url, min(t.at) as sent_at
       from leads l join touches t on t.lead_id = l.id and t.kind = 'sent'
       where l.company_id = $1 and l.status = 'contacted'
       group by l.id
       having count(*) = 1 and min(t.at) <= $2
       order by sent_at
       limit $3`,
      [input.company_id, cutoff, input.limit],
    );
    return { leads: leads.map((l) => ({ ...l, sent_at: new Date(l.sent_at).toISOString() })) };
  },
});
