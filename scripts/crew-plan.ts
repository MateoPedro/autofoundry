import { CREW_ROLES } from "../src/lib/server/foundry/roles";

export type CrewState = {
  agents: Partial<Record<string, string>>;
  identityId: string | null;
  inbox: { id: string; owning_agent_id: string } | null;
};

// What pnpm crew setup has to create. The seven agents come from their configs (pnpm parent, scout
// and compliance apply), so a missing one stops setup.
export function planCrewSetup(state: CrewState): { createIdentity: boolean; createInbox: boolean } {
  const missing = CREW_ROLES.filter((role) => !state.agents[role]);
  if (missing.length) throw new Error(`Apply these agents first: ${missing.join(", ")}.`);
  if (state.inbox && state.inbox.owning_agent_id !== state.agents.closer) throw new Error("The shared inbox is owned by another agent; give it to closer first.");
  return { createIdentity: !state.identityId, createInbox: !state.inbox };
}

export type CrewRow = { role: string; agent_id: string; board_id: string; identity_id?: string; inbox_id?: string; inbox_address?: string };

// client.database.query takes no parameters, so every value is checked against Naïve's id and
// address characters before it is written into the statement.
const SAFE = /^[a-z0-9_@.-]+$/;
const literal = (value: string | undefined) => {
  if (value === undefined) return "null";
  if (!SAFE.test(value)) throw new Error(`unsafe value for the crew table: ${JSON.stringify(value)}`);
  return `'${value}'`;
};

export function crewRowsSql(rows: CrewRow[]): string {
  const values = rows
    .map((r) => `(${[r.role, r.agent_id, r.board_id, r.identity_id, r.inbox_id, r.inbox_address].map(literal).join(", ")})`)
    .join(", ");
  return `insert into crew (role, agent_id, board_id, identity_id, inbox_id, inbox_address) values ${values}
on conflict (role) do update set agent_id = excluded.agent_id, board_id = excluded.board_id, identity_id = excluded.identity_id,
  inbox_id = excluded.inbox_id, inbox_address = excluded.inbox_address`;
}
