import type { z } from "zod";
import type { Db } from "../db";

export type ToolErrorCode = "not_found" | "invalid" | "conflict" | "not_approved" | "policy" | "killed" | "naive_error" | "internal";

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export type AgentSpend = { agent_id: string; agent_name: string; micro_usd: number };

export type SpendSource = { listAgentSpend(): Promise<AgentSpend[]> };

export type ToolContext = { db: Db; spend: SpendSource | null; now: () => Date };

export type Tool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run(ctx: ToolContext, input: unknown): Promise<unknown>;
};

export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, input: z.infer<S>): Promise<unknown>;
}): Tool {
  return tool as unknown as Tool;
}
