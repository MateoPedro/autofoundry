import { createPgDb } from "@/lib/server/db";
import { foundryTools } from "@/lib/server/foundry";
import { loadChildTemplate } from "@/lib/server/foundry/templates";
import type { ToolContext } from "@/lib/server/foundry/tool";
import { handleRpc, isAuthorized } from "@/lib/server/mcp/protocol";
import { createMonidReader } from "@/lib/server/monid";
import { createNaiveWriter, createSpendSource } from "@/lib/server/naive";

export const dynamic = "force-dynamic";

let context: ToolContext | undefined;

function toolContext(): ToolContext {
  if (!context) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    context = {
      db: createPgDb(url),
      spend: createSpendSource(process.env),
      naive: createNaiveWriter(process.env),
      childTemplate: () => loadChildTemplate(),
      now: () => new Date(),
      monid: process.env.MONID_API_KEY?.trim() ? createMonidReader(process.env.MONID_API_KEY.trim()) : null,
      monidDailyCapMicroUsd: Number(process.env.MONID_DAILY_CAP_MICRO_USD) || undefined,
    };
  }
  return context;
}

export async function POST(request: Request) {
  if (!isAuthorized(request.headers.get("authorization"), process.env.VETTA_MCP_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const response = await handleRpc(body, foundryTools, toolContext());
  return response === null ? new Response(null, { status: 202 }) : Response.json(response);
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export const DELETE = GET;
