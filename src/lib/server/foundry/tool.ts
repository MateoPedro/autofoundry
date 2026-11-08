import type { z } from "zod";
import type { Db } from "../db";
import type { MonidReader } from "../monid";
import type { ScreenModel } from "./screen";
import type { ChildTemplate } from "./templates";

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

export type Budget = { cap_micro_usd: number; max_task_micro_usd: number; period: "day" | "week" | "month" };

export type BoardCard = { id: string; board_id: string; status: string; blocked_by: string[] };

// The Naïve calls spawn, fund and kill make with NAIVE_WRITE_KEY. Tests pass a fake.
export type NaiveWriter = {
  systemDomain(): Promise<string>;
  createIdentity(body: { name: string; description: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  createApp(body: { name: string; description: string }): Promise<{ id: string }>;
  deployApp(appId: string, files: Record<string, string>): Promise<{ url: string }>;
  findAgent(name: string): Promise<{ id: string; metadata: Record<string, unknown> } | null>;
  createAgent(config: Record<string, unknown> & { name: string; budget: Budget }): Promise<{ id: string }>;
  attachIdentity(agentId: string, identityId: string): Promise<void>;
  findInbox(identityId: string, address: string): Promise<{ id: string } | null>;
  createInbox(identityId: string, body: { address: string; owning_agent_id: string }): Promise<{ id: string }>;
  ensureBoard(agentId: string): Promise<{ id: string }>;
  createCard(boardId: string, card: { title: string; body: string; assignee: string; key: string }): Promise<{ id: string }>;
  setBudget(agentId: string, budget: Budget): Promise<void>;
  getBudget(agentId: string): Promise<Budget>;
  cardsOf(agentId: string): Promise<BoardCard[]>;
  setCardStatus(boardId: string, cardId: string, status: "todo"): Promise<void>;
  findDeployment(agentId: string): Promise<{ id: string } | null>;
  createDeployment(body: { agent_id: string; cron: string; input_template: string; identity: string }): Promise<{ id: string }>;
  setDeploymentEnabled(deploymentId: string, enabled: boolean): Promise<void>;
};

export type ToolContext = {
  db: Db;
  spend: SpendSource | null;
  naive: NaiveWriter | null;
  childTemplate: () => Promise<ChildTemplate>;
  now: () => Date;
  // Monid reads for Scout (monid_read). Absent when MONID_API_KEY isn't set on the app.
  monid?: MonidReader | null;
  monidDailyCapMicroUsd?: number;
  sleep?: (ms: number) => Promise<void>;
  // The quick idea screen (screen_batch). Absent when the app's Naïve key lacks proxy:write.
  screenModel?: ScreenModel | null;
  screenRules?: () => Promise<string>;
};

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
