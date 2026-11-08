import assert from "node:assert/strict";
import test from "node:test";
import { crewRowsSql, planCrewSetup } from "../scripts/crew-plan";
import { CREW_ROLES } from "../src/lib/server/foundry/roles";

const agents = Object.fromEntries(CREW_ROLES.map((role) => [role, `agt_${role}`]));

test("crew setup plans only what's missing", () => {
  const plan = (identityId: string | null, inbox: { id: string; owning_agent_id: string } | null) => {
    const { createIdentity, createInbox } = planCrewSetup({ agents, identityId, inbox });
    return { createIdentity, createInbox };
  };
  assert.deepEqual(plan(null, null), { createIdentity: true, createInbox: true });
  assert.deepEqual(plan("idn_1", null), { createIdentity: false, createInbox: true });
  assert.deepEqual(plan("idn_1", { id: "eml_1", owning_agent_id: "agt_closer" }), { createIdentity: false, createInbox: false });
  assert.deepEqual(planCrewSetup({ agents, identityId: null, inbox: null }).agents, agents);
});

test("crew setup refuses when an agent is missing or the inbox has another owner", () => {
  const partial = Object.fromEntries(Object.entries(agents).filter(([role]) => role !== "vc" && role !== "closer"));
  assert.throws(() => planCrewSetup({ agents: partial, identityId: null, inbox: null }), /vc, closer/);
  assert.throws(() => planCrewSetup({ agents, identityId: "idn_1", inbox: { id: "eml_1", owning_agent_id: "agt_other" } }), /owned by another agent/);
});

test("the crew rows are one idempotent upsert of safe ids", () => {
  const rows = CREW_ROLES.map((role) => ({ role, agent_id: `agt_${role}`, board_id: `brd_${role}`, ...(role === "closer" ? { identity_id: "idn_1", inbox_id: "eml_1", inbox_address: "hello@x.usenaive.ai" } : {}) }));
  const sql = crewRowsSql(rows);
  assert.match(sql, /^insert into crew \(role, agent_id, board_id, identity_id, inbox_id, inbox_address\) values /);
  assert.match(sql, /on conflict \(role\) do update set/);
  assert.match(sql, /\('closer', 'agt_closer', 'brd_closer', 'idn_1', 'eml_1', 'hello@x.usenaive.ai'\)/);
  assert.match(sql, /\('vc', 'agt_vc', 'brd_vc', null, null, null\)/);
  assert.throws(() => crewRowsSql([{ role: "vc", agent_id: "agt_x'; drop table crew; --", board_id: "brd_1" }]), /unsafe/);
});
