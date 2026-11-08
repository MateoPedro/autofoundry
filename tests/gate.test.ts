import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Controls } from "../src/app/dashboard";
import { entryResponse, isOperator, operatorCookieValue } from "../src/lib/server/gate";

const env = { DASHBOARD_PASSWORD: "correct horse battery" };
const form = (fields: Record<string, string>) => new Request("https://foundry.test/api/entry", { method: "POST", body: new URLSearchParams(fields) });

test("the operator cookie can't be guessed from the URL alone", () => {
  const value = operatorCookieValue("secret");
  assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(isOperator(undefined, "secret"), false);
  assert.equal(isOperator("x", "secret"), false);
  assert.equal(isOperator(value, undefined), false);
  assert.equal(isOperator(value, "secret"), true);
  assert.equal(isOperator(value, "other"), false);
});

test("the dashboard password signs an operator in with a 30-day cookie", async () => {
  const res = await entryResponse(form({ password: "correct horse battery" }), env);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^foundry_operator=${operatorCookieValue("correct horse battery")};`));
  for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000", "Path=/"]) assert.ok(cookie.includes(part), part);
});

test("a wrong password, a ticket or no gate signs nobody in", async () => {
  for (const [fields, e] of [[{ password: "guess" }, env], [{ ticket: "t" }, env], [{ password: "" }, {}]] as const) {
    const res = await entryResponse(form(fields), e);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?entry=failed");
    assert.equal(res.headers.get("set-cookie"), null);
  }
});

test("the dashboard shows the controls only to an operator", () => {
  const html = (operator: boolean, running: boolean) => renderToStaticMarkup(createElement(Controls, { operator, running }));
  assert.doesNotMatch(html(false, false), /api\/control/);
  assert.match(html(false, false), /api\/entry/);
  assert.match(html(true, false), /action="\/api\/control\/launch"/);
  assert.doesNotMatch(html(true, false), /api\/control\/stop/);
  assert.match(html(true, true), /action="\/api\/control\/stop"/);
});
