import assert from "node:assert/strict";
import test from "node:test";
import { monidClient } from "../scripts/monid-client";

test("Monid catalog keeps credentials in headers and exposes no arbitrary execution", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const mock = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer fixture-secret");
    assert.ok(!init!.body!.toString().includes("fixture-secret"));
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return Response.json({ results: [] });
  };
  const client = monidClient("fixture-secret", mock as typeof fetch);
  await client.discover("twitter business requests");
  await client.inspect("twitterdata.io", "/tweets/search");
  assert.deepEqual(requests.map(r => r.url), ["https://api.monid.ai/v1/discover", "https://api.monid.ai/v1/inspect"]);
  assert.equal("run" in client, false);
  assert.throws(() => monidClient(""), /MONID_API_KEY/);
  await assert.rejects(client.inspect("tikhub", "https://other.example"), /endpoint path/);
});

test("Monid X reads enforce endpoint identity, read method, fixed per-call price and provider cap", async () => {
  for (const changed of [{}, { method: "POST" }, { provider: "other" }, { price: { type: "PER_RESULT", amount: { value: 0.00025, currency: "USD" } } }, { price: { type: "PER_CALL", amount: { value: 0.01, currency: "USD" } } }]) {
    const paths: string[] = [];
    const client = monidClient("fixture", (async (url, init) => {
      paths.push(String(url));
      if (String(url).endsWith("/inspect")) return Response.json({ provider: "twitterdata.io", endpoint: "/tweets/search", method: "GET", price: { type: "PER_CALL", amount: { value: 0.00025, currency: "USD" } }, ...changed });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.maxCost, 0.00025);
      assert.equal(body.input.queryParams.limit, 10);
      assert.equal(body.provider, "twitterdata.io");
      assert.equal(body.endpoint, "/tweets/search");
      return Response.json({ runId: "fixture-run-id-123456", status: "RUNNING" });
    }) as typeof fetch);
    if (Object.keys(changed).length) { await assert.rejects(client.searchPosts("need website"), /changed/); assert.equal(paths.length, 1); }
    else { await client.searchPosts("need website"); assert.equal(paths.length, 2); }
  }
});

test("Monid failures do not expose the provider's raw error or credentials", async () => {
  const client = monidClient("fixture-secret", (async () => new Response("raw private provider details", { status: 401 })) as typeof fetch);
  await assert.rejects(client.discover("twitter"), error => error instanceof Error && error.message === "Monid request failed (HTTP 401).");
});

test("page auditing cannot enable rendering, resource loads, custom code or higher pricing", async () => {
  let executions = 0;
  const client = monidClient("fixture", (async (url, init) => {
    if (String(url).endsWith("/inspect")) return Response.json({ provider: "dataforseo", endpoint: "/onpage/instant-pages", method: "POST", price: { type: "PER_CALL", amount: { value: 0.00015, currency: "USD" } } });
    executions++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.maxCost, 0.00015);
    assert.deepEqual(body.input.body, { url: "https://example.com/", enable_javascript: false, load_resources: false, enable_browser_rendering: false, enable_xhr: false, store_raw_html: false });
    return Response.json({ status: "COMPLETED" });
  }) as typeof fetch);
  await client.auditPage("https://example.com/");
  assert.equal(executions, 1);
  await assert.rejects(client.auditPage("http://example.com/"), /public HTTPS/);
  await assert.rejects(client.auditPage("https://127.0.0.1/"), /public HTTPS/);
  await assert.rejects(client.auditPage("https://user:password@example.com/"), /public HTTPS/);
});
