import { CREW_ROLES, ROLE_BUDGETS } from "../../src/lib/server/foundry/roles";
import type { ToolContext } from "../../src/lib/server/foundry/tool";
import type { FakeNaive } from "./fake-naive";

export async function seedCrew(ctx: ToolContext & { naive: FakeNaive }): Promise<void> {
  for (const role of CREW_ROLES) {
    const { id } = await ctx.naive.createAgent({ name: role, budget: { ...ROLE_BUDGETS[role], period: "day" } });
    const board = await ctx.naive.ensureBoard(id);
    const closer = role === "closer";
    await ctx.db.query("insert into crew (role, agent_id, board_id, identity_id, inbox_id, inbox_address) values ($1, $2, $3, $4, $5, $6)", [
      role,
      id,
      board.id,
      closer ? "idn_crew" : null,
      closer ? "eml_crew" : null,
      closer ? "hello@auto-foundry-03s9ve.usenaive.ai" : null,
    ]);
  }
}
