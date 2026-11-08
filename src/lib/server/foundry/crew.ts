import { z } from "zod";
import { newId } from "../ids";
import { proposeIfSampled } from "./leads";
import { defineTool, ToolError, type ToolContext } from "./tool";
import { postPending, queue, WORK } from "./work";

export const publishSample = defineTool({
  name: "publish_sample",
  writes: true,
  description:
    "Creator or Closer. Publish one lead's sample as a single self-contained HTML page (inline CSS, no scripts). The foundry serves it at <foundry>/s/<lead_id> and records a sample_delivered touch. Once every lead of a spawning company has a sample, the company is proposed for VC. On a funded company, the first publish hands the lead to Outreach. Publishing again replaces the page.",
  input: z.object({
    company_id: z.string().min(1),
    lead_id: z.string().min(1),
    agent_name: z.string().min(1).max(100),
    html: z.string().min(1).max(100_000),
  }),
  async run(ctx, input) {
    const { contact, ...result } = await publish(ctx, input);
    if (contact) await postPending(ctx, [contact]);
    return result;
  },
});

async function publish(ctx: ToolContext, input: { company_id: string; lead_id: string; agent_name: string; html: string }) {
  // The row lock serializes a company's publishes, so two last samples can't both miss the proposed step.
  return ctx.db.tx(async (db) => {
    const [company] = await db.query<{ status: string; channel: string }>(
      "select c.status, o.channel from companies c join offers o on o.id = c.offer_id where c.id = $1 for update of c",
      [input.company_id],
    );
    if (!company) throw new ToolError("not_found", `no company ${input.company_id}`);
    if (company.status === "killed") throw new ToolError("killed", `company ${input.company_id} is killed and takes no more work`);
    if (!["spawning", "proposed", "active"].includes(company.status)) throw new ToolError("conflict", `company ${input.company_id} is ${company.status}`);
    const [lead] = await db.query<{ id: string; status: string }>("select id, status from leads where id = $1 and company_id = $2", [
      input.lead_id,
      input.company_id,
    ]);
    if (!lead) throw new ToolError("not_found", `no lead ${input.lead_id} in company ${input.company_id}`);

    await db.query(
      `insert into samples (lead_id, company_id, html) values ($1, $2, $3)
       on conflict (lead_id) do update set html = excluded.html, updated_at = now()`,
      [lead.id, input.company_id, input.html],
    );
    const sampleUrl = `${ctx.appUrl}/s/${lead.id}`;
    await db.query("update leads set sample_url = $2 where id = $1", [lead.id, sampleUrl]);
    await db.query("insert into touches (id, company_id, lead_id, agent_name, channel, kind, detail) values ($1, $2, $3, $4, $5, 'sample_delivered', $6)", [
      newId("tc"),
      input.company_id,
      lead.id,
      input.agent_name,
      company.channel,
      sampleUrl,
    ]);

    const status = (await proposeIfSampled(db, input.company_id)) ? "proposed" : company.status;
    // Only a lead nobody has contacted goes to Outreach, after the sample commits; the card key keeps
    // a republish from waking it twice.
    const work = status === "active" && lead.status === "assigned" ? WORK.contact(lead.id, input.company_id) : null;
    if (work) await queue(db, work, ctx.now());
    return { lead_id: lead.id, sample_url: sampleUrl, company_status: status, handed_to: work ? "outreach" : null, contact: work?.key ?? null };
  });
}
