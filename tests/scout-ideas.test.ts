import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { ideasContext, revenueFor, titleKey, agentDomain, appSignals, consumerTopic, featureWish, isSmallEmployer, mapsGaps, pickIdeas, redditTask, reviewPains, scoutIdeas, Sources, TOOLS, type Idea, type MonidReader, type Pipeline } from "../scripts/scout-ideas";

test("classifiers flag observable gaps and complaints only", () => {
  assert.deepEqual(mapsGaps({ website: "https://acme.com/", operating_hours: {} }), []);
  assert.deepEqual(mapsGaps({ website: undefined }), ["no_website", "no_hours"]);
  assert.deepEqual(mapsGaps({ website: "https://www.facebook.com/acme", operating_hours: {} }), ["social_or_builder_site"]);
  assert.deepEqual(mapsGaps({ website: "http://acme.com/", operating_hours: {} }), ["http_link"]);
  assert.deepEqual(reviewPains("Called five times and nobody answered, went to voicemail."), ["phone"]);
  assert.deepEqual(reviewPains("Google said they were open but we showed up and it was closed."), ["hours"]);
  assert.deepEqual(reviewPains("Great food, friendly staff."), []);
  assert.equal(redditTask("Need help with bookkeeping for my bakery", ""), "bookkeeping");
  assert.equal(redditTask("My bookkeeping journey", "Just sharing a story."), null); // no ask, no demand
  assert.equal(redditTask("I’m building free websites for small businesses, how do I get clients?", ""), null, "sellers are not demand");
  assert.equal(redditTask("Need help keeping your business finances organised?", ""), null, "ads addressed to readers");
  assert.equal(redditTask("Looking for someone to redo our restaurant website", "We have a Wix site from 2015."), "website");
  assert.ok(isSmallEmployer("Russo's Italian Kitchen"));
  assert.ok(!isSmallEmployer("Robert Half Staffing"));
  assert.ok(!isSmallEmployer("remote quest jobs")); assert.ok(!isSmallEmployer("Aquent"));
  const now = new Date("2026-11-07T00:00:00Z");
  assert.deepEqual(appSignals({ supported_languages: ["EN"], rating: [{ count: 400, rating: 4.6 }], latest_version_release_date: "2026-10-01 10:00:00 UTC" }, now), ["english_only"]);
  assert.deepEqual(appSignals({ supported_languages: ["EN"], rating: [{ count: 290_000, rating: 4.9 }] }, now), [], "giants are excluded");
  assert.deepEqual(appSignals({ supported_languages: ["EN", "FR"], rating: [{ count: 80, rating: 3.1 }], latest_version_release_date: "2024-01-01 10:00:00 UTC" }, now), ["stale_listing", "low_rating"]);
});

const idea = (pipeline: Pipeline, score: number, leads: number): Idea => ({ pipeline, kind: `k${leads}`, rank: 0, why: "", leads: Array.from({ length: leads }, () => ({}) as Idea["leads"][number]),
  cluster: { label: `${pipeline}-${score}-${leads}`, source: pipeline, unserved_score: score } });

test("consumer and agent classifiers keep real asks and drop sensitive or bug posts", () => {
  assert.equal(consumerTopic("Is There An App...?", "that suggests meals from the ingredients in my pantry"), "food");
  assert.equal(consumerTopic("Is there an app for making friends only?", ""), "social");
  assert.equal(consumerTopic("Is there an app like grindr that isn't pay to play?", ""), null, "dating is excluded");
  assert.equal(consumerTopic("My budget this month", "just venting"), null, "no ask");
  assert.equal(consumerTopic("Looking for an app developer", "to build my budget app"), null, "hiring is not consumer demand");
  assert.equal(consumerTopic("Is there an app to track my budget?", "", true), null, "nsfw posts are excluded");
  assert.deepEqual(featureWish("Love it, but please add a home screen widget"), ["widgets"]);
  assert.deepEqual(featureWish("Great app with a widget"), [], "praise is not a wish");
  assert.equal(agentDomain("Feature: official MCP server so agents can search the mailbox"), "email");
  assert.equal(agentDomain("MCP sign-in never surfaces for plugin servers"), null, "bug reports are not demand");
  assert.equal(agentDomain("Kubeflow MCP Server v0.2 Release"), null);
  assert.equal(titleKey("Is there an app or website that builds a strategy?"), titleKey("Is there an app or website that builds a strategy"), "cross-posts collapse");
  assert.equal(agentDomain("Add MCP support for Postgres", null), "data", "GitHub returns null bodies");
});

test("selection keeps 2..5 ideas per pipeline and at most 20 overall", () => {
  const many = (p: Pipeline) => Array.from({ length: 8 }, (_, i) => idea(p, i / 10, i));
  const all: Pipeline[] = ["maps", "reviews", "appstore", "jobs", "reddit", "consumer_posts", "app_wishes", "agent_github", "agent_forums"];
  const picked = pickIdeas(Object.fromEntries(all.map(p => [p, many(p)])));
  const counts = Object.values(picked).map(i => i.length);
  assert.ok(counts.every(n => n >= 2 && n <= 5));
  assert.equal(counts.reduce((a, b) => a + b), 20);
  assert.equal(picked.maps![0].cluster.unserved_score, 0.7, "best ideas first");
  const thin = pickIdeas({ maps: [idea("maps", 0.2, 3)], reviews: [], appstore: many("appstore"), jobs: [], reddit: [] });
  assert.equal(thin.maps!.length, 1); assert.equal(thin.appstore!.length, 5);
});

test("source guard refuses price changes, retries only unbilled failures, and respects the cap", async () => {
  let runs = 0;
  const client = { data: {
    searchTools: async () => ({ data: [{ id: "t1", name: TOOLS.appstore.name, price: { basis: "per_call", micro_usd: 150, text: "" } },
      { id: "t2", name: TOOLS.jobs.name, price: { basis: "per_call", micro_usd: 9999, text: "$0.01" } }] }),
    getTool: async () => ({}),
    run: async () => { runs++; return runs === 1 ? { status: "failed", cost_micro_usd: 0, error: "503" } : { status: "succeeded", cost_micro_usd: 150, data: { ok: true } }; },
  } } as unknown as VettaClient;
  const s = new Sources(client, 400);
  assert.deepEqual(await s.run(TOOLS.appstore, { query: { term: "x" } }), { ok: true });
  assert.equal(runs, 2); assert.equal(s.spent, 150);
  assert.equal(await s.run(TOOLS.jobs, { body: { keyword: "x" } }), null);
  assert.match(s.notes.join(" "), /skipped|price changed/i);
  await s.run(TOOLS.appstore, { query: { term: "y" } });
  assert.equal(await s.run(TOOLS.appstore, { query: { term: "z" } }), null, "third call would exceed the 400 cap");
  assert.match(s.notes.at(-1)!, /cap/);
});

test("a full pass groups evidence into ideas, falls back from Yelp, saves once and replays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scout-ideas-"));
  const calls: Record<string, number> = {};
  const tools = Object.values(TOOLS).map((t, i) => ({ id: `id${i}`, name: t.name, price: { basis: "per_call", micro_usd: t.maxQuoteMicroUsd, text: "" } }));
  const listing = (n: number, cat: string) => ({ title: `${cat} ${n}`, place_id: `${cat}-${n}`, reviews: 40 + n, type: cat, ...(n % 2 ? {} : { website: "https://www.facebook.com/x", operating_hours: {} }) });
  const client = { data: {
    searchTools: async () => ({ data: tools }),
    getTool: async () => ({}),
    run: async ({ tool_id, query, body }: { tool_id: string; query?: Record<string, string>; body?: Record<string, string> }) => {
      const name = tools.find(t => t.id === tool_id)!.name;
      calls[name] = (calls[name] ?? 0) + 1;
      const ok = (data: unknown, cost = 150) => ({ status: "succeeded", cost_micro_usd: cost, data });
      if (name === TOOLS.yelpSearch.name) return { status: "failed", cost_micro_usd: 0, error: "503" };
      if (name === TOOLS.maps.name) return ok({ local_results: [1, 2, 3, 4].map(n => listing(n, query!.q)) });
      if (name === TOOLS.googleReviews.name) return ok({ reviews: [{ snippet: "Nobody answered the phone, again." }, { snippet: "The final bill was higher than the quote." }] });
      if (name === TOOLS.appstore.name) return ok({ organic_results: [1, 2].map(n => ({ id: n * 100 + query!.term.length, title: `${query!.term} ${n}`, link: "https://apps.apple.com/app/x", developer: { name: `${query!.term} dev ${n}`, link: "" }, supported_languages: ["EN"], rating: [{ count: 300, rating: 4.2 }], latest_version_release_date: "2026-10-01 00:00:00 UTC" })) });
      if (name === TOOLS.jobs.name) return ok([{ items: [1, 2].map(n => ({ job_id: `${body!.keyword}-${n}`, title: `${body!.keyword} role`, employer_name: `${body!.keyword} shop ${n}`, source_url: "https://example.com/job" })) }], 2400);
      if (name === TOOLS.reddit.name) return ok({ children: [1, 2].map(n => ({ post: { id: `${query!.query.length}-${n}`, permalink: `/r/smallbusiness/comments/${n}/`, postTitle: "Need help with social media for my shop" } })) }, 1000);
      throw new Error(`unexpected ${name}`);
    },
  } } as unknown as VettaClient;
  try {
    const { run } = await scoutIdeas(client, "fixture-ideas-1", undefined, { directory, now: () => new Date("2026-11-07T12:00:00Z"), monid: null });
    assert.ok(run.ideas.length >= 10, `got ${run.ideas.length}`);
    for (const p of ["maps", "reviews", "appstore", "jobs"] as const) assert.ok(run.per_pipeline[p] >= 1, p);
    assert.ok(run.ideas.every(i => i.leads.every(l => l.data.evidence.length && l.data.contact_verified === false && l.contact_url === null)));
    assert.match(run.notes.join(" "), /Yelp search unavailable/);
    assert.equal(calls[TOOLS.yelpSearch.name], 2, "unbilled 503 retried once, then fallback");
    assert.ok(run.spent_micro_usd > 0 && run.spent_micro_usd <= 40_000);
    const total = Object.values(calls).reduce((a, b) => a + b);
    const replay = await scoutIdeas(client, "fixture-ideas-1", undefined, { directory });
    assert.deepEqual(replay.run, run);
    assert.equal(Object.values(calls).reduce((a, b) => a + b), total, "replay makes no paid calls");
    await assert.rejects(scoutIdeas(client, "bad"), /Request ID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("large results are followed through their signed JSON link", async () => {
  const { unwrap } = await import("../scripts/scout-ideas");
  const fetcher = (async (url: string) => { assert.equal(url, "https://files.example/x"); return new Response(JSON.stringify({ organic_results: [1] })); }) as unknown as typeof fetch;
  assert.deepEqual(await unwrap({ data: { download_link: "https://files.example/x", content_type: "application/json" } }, fetcher), { organic_results: [1] });
  assert.deepEqual(await unwrap({ organic_results: [] }, fetcher), { organic_results: [] }, "inline data passes through");
  await assert.rejects(unwrap({ data: { download_link: "http://files.example/x", content_type: "application/json" } }, fetcher), /Unexpected/);
});

test("Monid reads poll an existing run, record reported cost and never retry", async () => {
  let started = 0, polled = 0;
  const reader = {
    readSource: async (name: string) => { started++; return name === "reddit" ? { runId: "01RUN000000000000000", status: "RUNNING" } : { runId: "01RUN000000000000001", status: "FAILED", providerResponse: { httpStatus: 502 }, cost: { value: 0.0024 } }; },
    getRun: async () => { polled++; return { runId: "01RUN000000000000000", status: "COMPLETED", providerResponse: { httpStatus: 200 }, cost: { value: 0.00035 }, output: { data: { posts: [] } } }; },
  } as unknown as MonidReader;
  const s = new Sources({ data: {} } as unknown as VettaClient, 60_000, reader);
  assert.deepEqual(await s.monid("reddit", { query: "x" }), { posts: [] });
  assert.equal(polled, 1); assert.equal(s.spent, 350);
  assert.equal(await s.monid("github_issues", { query: "y" }), null);
  assert.equal(started, 2, "a failed billed run is not retried"); assert.equal(s.spent, 2750);
  assert.equal(await new Sources({ data: {} } as unknown as VettaClient).monid("reddit", { query: "z" }), null);
});

test("every pipeline has a revenue path, and agent ideas are paid per call", () => {
  const kinds: [Pipeline, string][] = [["maps", "no_website"], ["reviews", "phone"], ["appstore", "english_only"], ["jobs", "bookkeeping"], ["reddit", "website"],
    ["consumer_posts", "food"], ["app_wishes", "widgets"], ["agent_github", "email"], ["agent_forums", "data"]];
  for (const [p, k] of kinds) {
    const r = revenueFor(p, k);
    assert.ok(r.price_usd > 0 && r.payer && r.offer && r.channel, p);
  }
  assert.equal(revenueFor("agent_github", "email").model, "per_call");
  assert.equal(revenueFor("maps", "no_website").channel_ready, true);
  assert.equal(revenueFor("consumer_posts", "food").channel_ready, false, "X replies are not a runnable channel yet");
});

test("the Scout handoff carries only the chosen ideas, bounded", () => {
  const lead = { name: "Acme", url: "https://acme.example", contact_url: null, email: null, external_id: "p1",
    data: { evidence: [{ url: "https://acme.example", observation: "no hours" }], issues: ["no_hours"], observed_at: "2026-11-07T00:00:00Z", discovery_query: "q", signal_type: "inferred_gap" as const, contact_verified: false, channel: "contact_form" } };
  const run = { request_id: "r", area: "a", started_at: "2026-11-07T00:00:00Z", finished_at: "", spent_micro_usd: 0, per_pipeline: {} as Record<Pipeline, number>, notes: [],
    ideas: [1, 2, 3].map(n => ({ ...idea("maps", 0.3, 0), leads: [lead], cluster: { label: `idea ${n}`, source: "google_maps", unserved_score: 0.3 } })) };
  const ctx = JSON.parse(ideasContext(run, [3, 1]));
  assert.deepEqual(ctx.ideas.map((i: { label: string }) => i.label), ["idea 3", "idea 1"]);
  assert.throws(() => ideasContext(run, [4]), /Pick/);
  assert.throws(() => ideasContext(run, [1, 1]), /Pick/);
  assert.throws(() => ideasContext(run, []), /Pick/);
});
