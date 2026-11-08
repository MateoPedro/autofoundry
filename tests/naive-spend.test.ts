import assert from "node:assert/strict";
import test from "node:test";
import { spendCredentials } from "../src/lib/server/naive";

test("the spend sync prefers the write key, which carries billing:read", () => {
  assert.deepEqual(spendCredentials({ NAIVE_WRITE_KEY: "w", NAIVE_API_KEY: "r", NAIVE_API_URL: "https://api.example" }), {
    apiKey: "w",
    baseUrl: "https://api.example",
  });
});

test("the spend sync falls back to the app's read key, then to nothing", () => {
  assert.deepEqual(spendCredentials({ NAIVE_API_KEY: " r " }), { apiKey: "r", baseUrl: "https://api.vetta.sh" });
  assert.equal(spendCredentials({}), null);
  assert.equal(spendCredentials({ NAIVE_WRITE_KEY: "  " }), null);
});
