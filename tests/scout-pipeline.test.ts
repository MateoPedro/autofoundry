import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { collectMapsPipeline } from "../scripts/scout-pipeline";

test("Maps pipeline caps source execution, deduplicates audited hosts and reuses completed receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scout-pipeline-"));
  let mapsCalls = 0, audits = 0;
  const client = { data: {
    searchTools: async () => ({ data: [{ id: "fresh-tool", name: "Google Maps Results", price: { basis: "per_call", micro_usd: 2000 } }] }),
    getTool: async (id: string) => { assert.equal(id, "fresh-tool"); },
    run: async (request: { tool_id: string; body: { depth: number; language_code: string } }) => {
      mapsCalls++; assert.equal(request.tool_id, "fresh-tool"); assert.equal(request.body.depth, 5); assert.equal(request.body.language_code, "en");
      return { status: "succeeded", cost_micro_usd: 2000, created_at: "2026-11-07T23:00:00Z",
        data: [{ items: ["one", "one", "two", "three", "four", "five"].map((n, i) => ({ place_id: `place-${i}`, title: n, url: `http://${n}.example/` })) }] };
    },
  } } as unknown as VettaClient;
  const monid = { auditPage: async (url: string) => {
    audits++; assert.ok(url.startsWith("https:"));
    return { runId: `fixture-${audits}`, status: "COMPLETED", providerResponse: { httpStatus: 200 }, billing: { reportedCost: { value: 150 } }, output: {} };
  }, getRun: async () => { throw new Error("No polling expected for completed reads"); } };
  try {
    const first = await collectMapsPipeline(client, "fixture-request-1", "SF dentists", { directory, monid });
    const again = await collectMapsPipeline(client, "fixture-request-1", "SF dentists", { directory, monid });
    assert.deepEqual(first, again);
    assert.equal(mapsCalls, 1); assert.equal(audits, 2);
    assert.equal(JSON.parse(first.context).listings.length, 5);
    await assert.rejects(collectMapsPipeline(client, "fixture-request-1", "other query", { directory, monid }), /different query/);
    assert.equal(mapsCalls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a lost Maps response cannot be automatically retried as a new paid collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scout-pipeline-failure-"));
  let calls = 0;
  const client = { data: {
    searchTools: async () => ({ data: [{ id: "fresh", name: "Google Maps Results", price: { basis: "per_call", micro_usd: 2000 } }] }),
    getTool: async () => ({}), run: async () => { calls++; throw new Error("response lost"); },
  } } as unknown as VettaClient;
  const monid = { auditPage: async () => { throw new Error("Must not audit after source failure"); }, getRun: async () => ({}) };
  try {
    await assert.rejects(collectMapsPipeline(client, "failed-request-1", "SF dentists", { directory, monid }), /response lost/);
    await assert.rejects(collectMapsPipeline(client, "failed-request-1", "SF dentists", { directory, monid }), /already started/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
