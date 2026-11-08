import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { screenCandidates, screenIdeas, validateIdeaScreen, SCREEN_MAX_TOKENS } from "../scripts/compliance-screen";

function source(count = 20) { return { ideas: Array.from({ length: count }, (_, n) => ({ buyer: n % 2 ? "agent" : "business", pipeline: "test",
  cluster: { label: `Experimental idea ${n + 1}` }, why: "A promising but unverified demand signal",
  revenue: { payer: "Possible buyer", offer: "A small digital experiment", model: "per_call", price_usd: 0.002, channel_ready: false },
  leads: [{ email: "private-contact@example.test", name: "Private contact", data: { raw: "PRIVATE_PAYLOAD" } }] })) }; }
function verdict(count = 20, keep = 12) { return {
  selected: Array.from({ length: keep }, (_, i) => ({ pick: i + 1, reason: "Interesting cheap experiment", experiment: "Try a synthetic prototype", risks: ["Check licensing later"] })),
  excluded: Array.from({ length: count - keep }, (_, i) => ({ pick: keep + i + 1, category: "lower_priority", reason: "Less unusual than the selected alternatives" })),
}; }

test("unverified demand, price and checkout remain eligible; private leads are omitted", () => {
  const candidates = screenCandidates(source());
  assert.ok(!JSON.stringify(candidates).includes("PRIVATE_PAYLOAD"));
  assert.ok(!JSON.stringify(candidates).includes("private-contact"));
  assert.ok(candidates.every(c => !c.revenue_hypothesis?.channel_ready));
  const result = validateIdeaScreen(verdict(), candidates);
  assert.equal(result.selected.length, 12); assert.equal(result.launch_approved, false);
  assert.equal(result.selected[0].title, "Experimental idea 1");
});

test("every idea needs one verdict; 8–12 is a target with honest shortfall for clear blockers", () => {
  const candidates = screenCandidates(source());
  assert.throws(() => validateIdeaScreen(verdict(20, 7), candidates), /underfilled/);
  const blocked = verdict(20, 7); blocked.excluded.forEach(x => { x.category = "obvious_illegal"; });
  assert.equal(validateIdeaScreen(blocked, candidates).shortfall, 1);
  const duplicate = verdict(); duplicate.selected[1].pick = 1;
  assert.throws(() => validateIdeaScreen(duplicate, candidates), /exactly once/);
  const missing = verdict(); missing.excluded.pop();
  assert.throws(() => validateIdeaScreen(missing, candidates), /exactly once/);
  const foreign = verdict(); foreign.selected[0].pick = 20;
  assert.throws(() => validateIdeaScreen(foreign, candidates), /exactly once/);
  assert.throws(() => screenCandidates(source(21)));
});

test("one bounded, low-thinking model call; replay has no paid call and billing stays factual", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-screen-"));const inputs = join(root, "ideas"), outputs = join(root, "screens");await mkdir(inputs);
  const path = join(inputs, "source.json");await writeFile(path, JSON.stringify(source()));let calls = 0;
  const fake = { models: { retrieve: async () => ({}) }, proxy: {
    messages: async (body: Record<string, unknown>) => { calls++;assert.equal(body.max_tokens, SCREEN_MAX_TOKENS);assert.deepEqual(body.thinking, { type: "disabled" });assert.equal(body.tools, undefined);
      assert.ok(!JSON.stringify(body).includes("PRIVATE_PAYLOAD"));
      return { id: "req_test", model: String(body.model), stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify(verdict()) }] }; },
    call: async () => ({ billed_micro_usd: 1234 }),
  } } as unknown as Pick<VettaClient, "models" | "proxy">;
  const first = await screenIdeas(fake, path, "screen-001", outputs, inputs);
  assert.equal(first.report.billed_micro_usd, 1234);assert.equal(first.report.selected.length, 12);
  assert.match(await readFile(first.textPath, "utf8"), /First test/);
  assert.equal((await screenIdeas(fake, path, "screen-001", outputs, inputs)).replayed, true);assert.equal(calls, 1);
  const changed = source();changed.ideas[0].why = "A different observation";await writeFile(path, JSON.stringify(changed));
  await assert.rejects(screenIdeas(fake, path, "screen-001", outputs, inputs), /different input/);assert.equal(calls, 1);
});

test("a lost response cannot start a blind paid retry; symlinks cannot read outside Scout inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea-screen-fail-"));const inputs = join(root, "ideas"), outputs = join(root, "screens");await mkdir(inputs);
  const path = join(inputs, "source.json");await writeFile(path, JSON.stringify(source()));let calls = 0;
  const fake = { models: { retrieve: async () => ({}) }, proxy: { messages: async () => { calls++;throw new Error("Response lost"); } } } as unknown as Pick<VettaClient, "models" | "proxy">;
  await assert.rejects(screenIdeas(fake, path, "lost-001", outputs, inputs), /Response lost/);
  await assert.rejects(screenIdeas(fake, path, "lost-001", outputs, inputs), /already started/);assert.equal(calls, 1);
  const external = join(root, "external.json");await writeFile(external, JSON.stringify(source()));await symlink(external, join(inputs, "linked.json"));
  await assert.rejects(screenIdeas(fake, join(inputs, "linked.json"), "linked-001", outputs, inputs), /saved Scout/);assert.equal(calls, 1);
});
