import { createPgDb } from "./db";
import { loadChildTemplate } from "./foundry/templates";
import type { ToolContext } from "./foundry/tool";
import { createMonidReader } from "./monid";
import { createNaivePayments, createNaiveWriter, createSpendSource } from "./naive";
import { createStripePayments } from "./stripe";

let context: ToolContext | undefined;

// One per server instance, shared by the MCP endpoint and the order events endpoint.
export function appContext(): ToolContext {
  if (!context) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    context = {
      db: createPgDb(url),
      spend: createSpendSource(process.env),
      naive: createNaiveWriter(process.env),
      payments: createStripePayments(process.env) ?? createNaivePayments(process.env),
      childTemplate: () => loadChildTemplate(),
      now: () => new Date(),
      monid: process.env.MONID_API_KEY?.trim() ? createMonidReader(process.env.MONID_API_KEY.trim()) : null,
      monidDailyCapMicroUsd: Number(process.env.MONID_DAILY_CAP_MICRO_USD) || undefined,
    };
  }
  return context;
}
