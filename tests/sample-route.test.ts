import assert from "node:assert/strict";
import test from "node:test";
import { publishSample } from "../src/lib/server/foundry/crew";
import { serveSample } from "../src/lib/server/samples";
import { page, spawned } from "./helpers/company";
import { run } from "./helpers/fixtures";

test("the sample route serves stored HTML under a strict policy, and 404s otherwise", async () => {
  const s = await spawned(1);
  const [leadId] = s.sampled;
  assert.equal((await serveSample(s.ctx.db, leadId)).status, 404);
  await run(publishSample, s.ctx, { company_id: s.companyId, lead_id: leadId, agent_name: "creator", html: page(leadId) });

  const res = await serveSample(s.ctx.db, leadId);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await res.text(), page(leadId));
  for (const bad of ["ld_missing", "../etc", "ld_x' or 1=1"]) assert.equal((await serveSample(s.ctx.db, bad)).status, 404, bad);
});
