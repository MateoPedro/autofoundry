import { CREW_ROLES, ROLE_BUDGETS } from "../../src/lib/server/foundry/roles";
import type { ToolContext } from "../../src/lib/server/foundry/tool";
import { FakeNaive } from "./fake-naive";
import { testContext } from "./fixtures";

export async function seedCrew(ctx: ToolContext & { naive: FakeNaive }): Promise<void> {
  for (const role of CREW_ROLES) {
    const agent = ctx.naive.addAgent(role, { ...ROLE_BUDGETS[role], period: "day" });
    const closer = role === "closer";
    await ctx.db.query("insert into crew (role, agent_id, board_id, identity_id, inbox_id, inbox_address) values ($1, $2, $3, $4, $5, $6)", [
      role,
      agent.id,
      agent.board_id,
      closer ? "idn_crew" : null,
      closer ? "eml_crew" : null,
      closer ? "hello@auto-foundry-03s9ve.usenaive.ai" : null,
    ]);
  }
}

export async function crewContext() {
  const naive = new FakeNaive();
  const ctx = { ...(await testContext({ naive })), naive };
  await seedCrew(ctx);
  return ctx;
}
