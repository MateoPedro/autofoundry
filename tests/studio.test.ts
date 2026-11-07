import assert from "node:assert/strict";
import test from "node:test";
import { createStudio, fundCompany, policy, spawnCompany, stopCompany, type Studio } from "../src/lib/studio";

function totalCapital(studio: Studio) {
  return studio.availableCents + studio.companies.reduce((sum, company) => sum + company.budgetCents, 0);
}

test("spawning, funding, and stopping conserve total studio capital", () => {
  const initial = createStudio();
  const spawned = spawnCompany(initial, "Creator tools", "creators");
  const funded = fundCompany(spawned, "creators");
  const stopped = stopCompany(funded, "creators");
  for (const state of [initial, spawned, funded, stopped]) assert.equal(totalCapital(state), policy.totalBudgetCents);
  assert.equal(stopped.availableCents, initial.availableCents);
  assert.equal(initial.companies.length, 2);
  assert.equal(stopped.companies[0].status, "stopped");
});

test("stopping returns only unspent capital and cannot return it twice", () => {
  const studio = createStudio();
  const stopped = stopCompany(studio, "briefly");
  assert.equal(stopped.availableCents, studio.availableCents + 8_000);
  assert.equal(stopped.companies.find((company) => company.id === "briefly")?.budgetCents, 2_000);
  assert.throws(() => stopCompany(stopped, "briefly"), /already been stopped/);
  assert.throws(() => fundCompany(stopped, "briefly"), /already been stopped/);
});

test("funding rejects invalid amounts, company caps, and insufficient reserves", () => {
  const studio = createStudio();
  for (const amount of [-1, 0, 0.5, NaN, Infinity]) assert.throws(() => fundCompany(studio, "briefly", amount), /whole number/);
  assert.throws(() => fundCompany(studio, "briefly", 40_001), /budget cap/);
  assert.throws(() => fundCompany({ ...studio, availableCents: 0 }, "briefly"), /insufficient budget/);
  assert.throws(() => fundCompany(studio, "missing"), /not found/);
});

test("spawning enforces available capital, unique IDs, themes, and active company limit", () => {
  let studio = createStudio();
  assert.throws(() => spawnCompany(studio, "a", "short"), /between 2 and 80/);
  assert.throws(() => spawnCompany(studio, "x".repeat(81), "long"), /between 2 and 80/);
  assert.throws(() => spawnCompany(studio, "Creator tools", "briefly"), /unique ID/);
  assert.throws(() => spawnCompany({ ...studio, availableCents: 0 }, "Creator tools", "new"), /not enough/);
  for (let i = 0; i < 8; i++) studio = spawnCompany(studio, "Creator tools", `company-${i}`);
  assert.throws(() => spawnCompany(studio, "More tools", "eleventh"), /up to 10/);
  const afterStop = stopCompany(studio, "company-0");
  assert.equal(spawnCompany(afterStop, "New tools", "replacement").companies.filter((company) => company.status === "active").length, 10);
});
